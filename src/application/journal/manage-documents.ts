/**
 * application層: 取込んだ証憑（JournalDocument）の保存・一覧・取得・削除（docs/20 §2.1 / §9）。
 *
 * ## 保存時に facts を正規化する
 *
 * 判定（`conditions.ts`）は `facts` だけを見るので、**保存の時点で同じ形に揃える**のがこの層の仕事になる。
 * 手入力・JSON 貼付・CSV プリセット・（フェーズ 2 の）LLM 抽出のどの経路から来ても、
 * `descriptionNorm`・`registrationNumber`・`counterpartyHint` が同じ規則で埋まっていることを保証する。
 * 正規化の規則そのものは domain（`normalize.ts`）が持つ。
 *
 * ## facts が変わったら判定をやり直させる
 *
 * 帳票の項目を直したのに以前の判定結果と仕訳が残っていると、画面には「確定済み」と出るのに
 * 中身は古い金額のまま、という状態になる。facts が変わった更新では `judgment` / `entryId` を落として
 * `extracted`（未判定）へ戻す。facts が同じなら状態は保つ（種別や添付だけ直した場合）。
 */
import { randomUUID } from 'node:crypto';
import {
  createJournalDocument, validateDocumentFacts,
  type DocumentFacts, type DocumentKind, type Extraction, type JournalDocument,
  type JournalDocumentSource, type JournalDocumentSummary,
} from '../../domain/journal/document';
import { JournalDocumentNotFoundError } from '../../domain/journal/errors';
import { counterpartyFromDescription, normalizeDescription, normalizeRegistrationNumber } from '../../domain/journal/normalize';
import type { JournalDocumentListOptions, JournalDocumentRepository, JournalEntryRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface SaveJournalDocumentInput {
  readonly scope: TenantScope;
  /** 省略で新規、指定で更新（無ければその id で新規）。 */
  readonly id?: string;
  readonly kind: DocumentKind;
  readonly source: JournalDocumentSource;
  readonly facts: DocumentFacts;
  readonly extraction?: Extraction;
}

/**
 * 判定が見る形へ facts を揃える（純粋。domain の正規化関数だけを使う）。
 *
 * - `descriptionNorm`: 原文があれば必ず作り直す（原文を直したのに正規化が古いままになるのを防ぐ）。
 *   原文が無く正規化済みだけ渡された場合（JSON 貼付）はそれを尊重する。
 * - `registrationNumber`: `T` + 13 桁へ寄せる。寄せられない値は「未取得」として落とす
 *   （domain の検証は形の合わない登録番号を拒否するので、ここで落とさないと保存自体が 400 になる）。
 * - `counterpartyHint`: 与えられていなければ正規化済み摘要から切り出す。
 */
export function normalizeJournalFacts(facts: DocumentFacts): DocumentFacts {
  const registrationNumber = facts.registrationNumber === undefined ? undefined : normalizeRegistrationNumber(facts.registrationNumber);
  const descriptionNorm = facts.description === undefined
    ? facts.descriptionNorm
    : (normalizeDescription(facts.description) || undefined);
  const counterpartyHint = facts.counterpartyHint ?? (descriptionNorm === undefined ? undefined : counterpartyFromDescription(descriptionNorm));
  const normalized: DocumentFacts = {
    ...facts,
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(descriptionNorm === undefined ? {} : { descriptionNorm }),
    ...(counterpartyHint === undefined ? {} : { counterpartyHint }),
  };
  // 形の合わない登録番号は落とす（スプレッドでは消せないので明示的に削る）。
  if (registrationNumber === undefined && 'registrationNumber' in normalized) {
    const { registrationNumber: _dropped, ...rest } = normalized;
    return validateDocumentFacts(rest);
  }
  return validateDocumentFacts(normalized);
}

export class SaveJournalDocumentUseCase {
  constructor(
    private readonly documents: JournalDocumentRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveJournalDocumentInput): Promise<JournalDocument> {
    const at = this.now().toISOString();
    const existing = input.id === undefined ? null : await this.documents.findById(input.scope, input.id);
    const facts = normalizeJournalFacts(input.facts);
    // 既存 facts も同じ検証を通っているので、JSON 表現の一致で「中身が変わったか」を判定できる
    // （`validateDocumentFacts` はキーの並びを固定する）。
    const factsChanged = existing !== null && JSON.stringify(existing.facts) !== JSON.stringify(facts);
    const keep = existing !== null && !factsChanged;

    const document = createJournalDocument({
      tenant: input.scope,
      ...(input.id === undefined ? {} : { id: input.id }),
      kind: input.kind,
      source: input.source,
      facts,
      ...(input.extraction === undefined ? {} : { extraction: input.extraction }),
      // facts が変わった更新は未判定へ戻す（前回の判定結果と仕訳参照は捨てる）。
      ...(keep
        ? {
          status: existing.status,
          ...(existing.judgment === undefined ? {} : { judgment: existing.judgment }),
          ...(existing.entryId === undefined ? {} : { entryId: existing.entryId }),
          ...(existing.hearingId === undefined ? {} : { hearingId: existing.hearingId }),
        }
        : { status: 'extracted' as const }),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }, this.makeId);
    await this.documents.save(document);
    return document;
  }
}

export class ListJournalDocumentsUseCase {
  constructor(private readonly documents: JournalDocumentRepository) {}

  /** 要約のみ（画像 data URL・原文・CSV 行を含まない）。新しいものが先。 */
  async execute(scope: TenantScope, options?: JournalDocumentListOptions): Promise<readonly JournalDocumentSummary[]> {
    return this.documents.list(scope, options);
  }
}

export class GetJournalDocumentUseCase {
  constructor(private readonly documents: JournalDocumentRepository) {}

  async execute(scope: TenantScope, id: string): Promise<JournalDocument> {
    const document = await this.documents.findById(scope, id);
    if (document === null) throw new JournalDocumentNotFoundError(`journal document not found: ${id}`);
    return document;
  }
}

/**
 * 文書を削除する。**紐づく仕訳が下書きのままなら一緒に削除する**。
 *
 * 下書きは判定が自動で作ったもので、元の証憑が消えれば残す意味が無い（一覧に出所不明の下書きが溜まる）。
 * 確定済み・出力済みの仕訳は会計上の記録なので、文書だけを消して仕訳は残す。
 */
export class DeleteJournalDocumentUseCase {
  constructor(
    private readonly documents: JournalDocumentRepository,
    private readonly entries: JournalEntryRepository,
  ) {}

  async execute(scope: TenantScope, id: string): Promise<void> {
    const document = await this.documents.findById(scope, id);
    if (document === null) throw new JournalDocumentNotFoundError(`journal document not found: ${id}`);
    if (document.entryId !== undefined) {
      const entry = await this.entries.findById(scope, document.entryId);
      if (entry !== null && entry.status === 'draft') await this.entries.delete(scope, entry.id);
    }
    await this.documents.delete(scope, id);
  }
}