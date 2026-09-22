/**
 * application層: 経費専用の追加読取（docs/21 §20.7.1 / ADR-0043 §10。`ReceiptDetailReaderPort` の実装。系統 C）。
 *
 * 仕訳の読取（`ExtractJournalDocumentUseCase`）は変えず、その結果の下書きに対して**同じ画像で追加の構造化抽出**を行う。
 * モデルには印字どおりの文字列だけを書き写させ（プロンプト版 `expense-detail/v1`）、変換と照合は domain の `mergeExpenseDetail` が行う。
 *
 * - 使えない（モデル未設定・構造化出力や vision が無い・test プロファイル）ときは 409 `EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE`（`missing` 付き）。
 * - 応答がスキーマに合わない・モデル呼び出しが失敗したときは**修復を求めず**（12B 級で 1 枚数分かかるので遅延を増やさない）、
 *   `detail-read-failed` の印と注意を付けて仕訳の読取の結果をそのまま返す（取込は続けられる）。中断（`signal`）だけはそのまま投げる。
 */
import { EXPENSE_DETAIL_READ_JSON_SCHEMA, parseExpenseDetailRead, type ExpenseDetailRead, type ExpenseDetailRecord, type ExtractionFlag } from '../../../domain/expense/detail-read';
import { ExpenseDetailExtractionUnavailableError, ExpenseDomainError, type ExpenseModelUnavailableReason } from '../../../domain/expense/errors';
import { mergeExpenseDetail } from '../../../domain/expense/input/detail-merge';
import { findCategory } from '../../../domain/expense/policy';
import { validateReceiptFacts } from '../../../domain/expense/receipt-facts';
import type { JsonSchemaObject, ModelCapability, ModelCompletionRequest, ModelContentPart, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import type { PromptTemplate } from '../../prompt/prompt-template';
import { loadExpensePolicy } from '../manage-policy';
import type { ReceiptDetailReaderPort, ReceiptDetailReadResult } from '../ports';
import type { ExpenseItemDraft } from '../receipt-drafts';
import type { ExpenseSystemDeps } from '../system-deps';

export const DETAIL_READ_MAX_IMAGES = 4;
/** プロンプトファイル（v48 / ADR-0052）。文面は `prompts/expense/detail-read.md`、版はそのファイルの frontmatter が正。 */
export const EXPENSE_DETAIL_READ_PROMPT: PromptSpec = { id: 'expense/detail-read', sections: ['system'] };

/** モデルの配線（composition が `BusinessCompositionContext` から作る）。 */
export interface ExpenseModelBinding {
  readonly provider: ModelProviderPort;
  /** main モデルが使える構成か（test プロファイル・未設定は false）。 */
  readonly enabled: () => boolean | Promise<boolean>;
  /** 保存済み設定を解決した能力（省略時は `provider.capabilities()`）。 */
  readonly capabilities?: () => readonly ModelCapability[] | Promise<readonly ModelCapability[]>;
  /** 記録に残すモデル名（取れなくても読取は返す）。 */
  readonly snapshot?: () => Promise<{ readonly provider: string; readonly model: string } | undefined>;
}

/** モデルの可否（足りないもの）。使えるなら undefined。 */
export async function missingModelCapability(model: ExpenseModelBinding | undefined, needsVision: boolean): Promise<ExpenseModelUnavailableReason | undefined> {
  if (model === undefined || !await model.enabled()) return 'model';
  const capabilities = await (model.capabilities?.() ?? model.provider.capabilities());
  if (!capabilities.includes('structured-output')) return 'structured-output';
  if (needsVision && !capabilities.includes('vision')) return 'vision';
  return undefined;
}

export async function modelSnapshotOf(model: ExpenseModelBinding | undefined): Promise<{ readonly provider: string; readonly model: string } | undefined> {
  try {
    const snapshot = await model?.snapshot?.();
    return snapshot === undefined ? undefined : { provider: snapshot.provider, model: snapshot.model };
  } catch {
    return undefined; // 表示用の情報が取れないだけで結果は返せる。
  }
}

const UNAVAILABLE_MESSAGES: Readonly<Record<ExpenseModelUnavailableReason, string>> = {
  model: 'the expense detail reading needs a model: choose the main model in Settings > Models, or read the receipt without the additional reading',
  'structured-output': 'the expense detail reading needs a model with structured output; the main model does not support it (Settings > Models)',
  vision: 'the expense detail reading reads images and needs a vision model; the main model cannot read images (Settings > Models)',
};

function buildRequest(images: readonly string[], draft: ExpenseItemDraft, template: PromptTemplate): ModelCompletionRequest {
  const context = { promptVersion: template.version, imageCount: images.length, ...(draft.extraction.documentKind === undefined ? {} : { documentKind: draft.extraction.documentKind }) };
  const parts: ModelContentPart[] = [{ type: 'text', text: `読み取りの文脈: ${JSON.stringify(context)}` }, ...images.map((image): ModelContentPart => ({ type: 'image_url', imageUrl: image }))];
  return {
    messages: [{ role: 'system', content: template.render('system') }, { role: 'user', content: parts }],
    temperature: 0,
    responseFormat: { name: 'expense_detail_read', strict: true, schema: EXPENSE_DETAIL_READ_JSON_SCHEMA as unknown as JsonSchemaObject },
  };
}

function parseJson(content: string | null): unknown {
  if (content === null) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withFlags(draft: ExpenseItemDraft, flags: readonly ExtractionFlag[], extra: Partial<ExpenseItemDraft['extraction']> = {}): ExpenseItemDraft {
  const { flags: _previous, ...extraction } = draft.extraction;
  return { ...draft, extraction: { ...extraction, ...extra, ...(flags.length === 0 ? {} : { flags: [...new Set(flags)] }) } };
}

export class InputReceiptDetailReader implements ReceiptDetailReaderPort {
  constructor(
    private readonly deps: Pick<ExpenseSystemDeps, 'repositories' | 'now'>,
    private readonly promptCatalog: PromptCatalogPort,
    private readonly model?: ExpenseModelBinding,
  ) {}

  async available(): Promise<boolean> {
    return await missingModelCapability(this.model, true) === undefined;
  }

  async read(input: Parameters<ReceiptDetailReaderPort['read']>[0], signal?: AbortSignal): Promise<ReceiptDetailReadResult> {
    const missing = await missingModelCapability(this.model, true);
    if (missing !== undefined || this.model === undefined) throw new ExpenseDetailExtractionUnavailableError(UNAVAILABLE_MESSAGES[missing ?? 'model'], missing ?? 'model');
    if (input.images.length === 0 || input.images.length > DETAIL_READ_MAX_IMAGES) {
      throw new ExpenseDomainError(`expense detail reading: 1 to ${DETAIL_READ_MAX_IMAGES} images are required (received ${input.images.length})`);
    }
    const { policy } = await loadExpensePolicy(this.deps.repositories.policies, input.scope);
    const routeWanted = findCategory(policy, input.draft.categoryId)?.route !== undefined;

    const template = this.promptCatalog.get(EXPENSE_DETAIL_READ_PROMPT.id);
    let read: ExpenseDetailRead | undefined;
    let failure = '';
    try {
      const completion = await this.model.provider.complete(buildRequest(input.images, input.draft, template), signal);
      read = parseExpenseDetailRead(parseJson(completion.message.content));
      if (read === undefined) failure = `応答が決まった形（${template.version}）になりませんでした`;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      failure = messageOf(error);
    }
    if (read === undefined) {
      const kept = (input.draft.extraction.flags ?? []).filter((flag) => flag !== 'detail-read-failed');
      return {
        draft: withFlags(input.draft, [...kept, 'detail-read-failed']),
        disagreements: [],
        warnings: [`経費の追加読取に失敗しました（${failure}）。仕訳の読取の結果はそのまま使えます。もう一度「追加で読む」を押すか、領収書を見て入力してください`],
      };
    }

    const merged = mergeExpenseDetail(input.draft, read, { routeWanted });
    const warnings = [...merged.warnings];
    let facts = merged.facts;
    let flags = merged.flags;
    try {
      facts = validateReceiptFacts(merged.facts);
    } catch (error) {
      // 候補の値が保存の形に合わなければ候補を入れない（印も付けない）。読取の記録は残す。
      facts = input.draft.facts;
      flags = flags.filter((flag) => flag !== 'attendees-read' && flag !== 'route-read' && flag !== 'payee-read');
      warnings.push(`追加の読取の候補が形に合わなかったので入れていません: ${messageOf(error)}`);
    }
    const model = await modelSnapshotOf(this.model);
    const detail: ExpenseDetailRecord = {
      promptVersion: template.version,
      ...(model === undefined ? {} : { model }),
      readAt: this.deps.now().toISOString(),
      raw: read,
      disagreements: merged.disagreements,
    };
    const rejected = input.draft.extraction.rejectedRegistrationNumber ?? merged.rejectedRegistrationNumber;
    const draft = withFlags({ ...input.draft, facts }, flags, { detail, ...(rejected === undefined ? {} : { rejectedRegistrationNumber: rejected }) });
    return { draft, disagreements: merged.disagreements, warnings };
  }
}
