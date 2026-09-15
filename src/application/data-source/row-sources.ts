/**
 * application層: 業務の行ソース（実行直前に行を差し込むノード）の登録点。
 *
 * 仕訳の `journal-entries` のように、domain のソースノードはリポジトリ・モデル・実行文脈へ到達できない。
 * そこで実行直前に `ResolveDataSourceGraphUseCase` が行を取り、固定スキーマ付きの `json-source` へ書き換える。
 * 以前はこの書き換えがノード型ごとの if 列挙で、業務を 1 つ足すたびに共有のリゾルバとコンストラクタ引数を
 * 触る必要があった。ここでは「ノード型 → 行の取り方」を業務側が宣言し、**書き換えの規律は共通側の 1 か所**
 * （`resolveRowSourceNode`）に持つ（ADR-0039）。
 *
 * 共通側が保証する規律:
 * - 実行文脈が要るソースは、文脈の無い呼び出し（保存・スキーマ点検・プレビュー）では書き換えない。
 *   ここで落とすと、そのノードを使う組込みツールの登録が起動時に失敗する。未解決のノードは自前の固定スキーマを返す。
 * - 行の取り方が配線されていなければ、空表ではなく理由付きで落とす（空表は「0 件」と読めてしまう）。
 * - 添付が必須のソースで添付が無ければ、利用者が直せる形の理由で落とす。
 * - 行にはスキーマを明示して渡す。0 件でも列が消えず、下流の filter が列を見失わない。
 *
 * 設定（config）の形の検査は業務ごとに違うので `rows` の中で行う（ポートを呼ぶ前に落とすこと）。
 */
import type { Row, Schema } from '../../domain/data/types';
import type { GraphNode } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DataSourceValidationError } from './manage-data-sources';

/** いまの実行に添付された帳票（画像）。`ImageAttachment` と同じ形を構造的に受ける。 */
export interface ResolveAttachment {
  readonly name: string;
  readonly dataUrl: string;
}

/**
 * いまの実行に添付されたテキスト（ブラウザで PDF のテキスト層から抜いた契約書の本文など。docs/23 §9.4 C4）。
 * 画像と違いモデルへのメッセージには本文を載せないので、ツールはこの文脈からしか本文を読めない。
 */
export interface ResolveDocument {
  readonly name: string;
  readonly text: string;
  readonly pageCount?: number;
}

/**
 * 実行ごとに変わる文脈。テナント範囲と違い、ツール呼び出しのたびに違う値になる。
 * 添付はツールの引数では運べない（数 MB の base64 や数十万文字の本文をモデルに書かせることになる）ので、ここで渡す。
 * `attachments`（画像）と `documents`（テキスト）は別の一覧で、既存の画像の形は変えない。
 */
export interface ResolveGraphContext {
  readonly attachments?: readonly ResolveAttachment[];
  readonly documents?: readonly ResolveDocument[];
  /**
   * いまのツール呼び出しの引数（`agent-input` に束縛される値。docs/21 §20.14 G-2）。
   * filter の `valueBinding` では「行の作り方」そのもの（集計の粒度・期間の範囲）を変えられないので、行ソースへ直接渡す。
   */
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/**
 * 行ソースが実行文脈に何を要るか。
 * - `none`: 文脈に依らない（保存時の点検でも行を読む。仕訳の `journal-entries`）。
 * - `context`: 文脈がある呼び出しでだけ書き換える（添付は任意）。
 * - `attachments`: `context` に加え、**画像**の添付が 1 件以上必要（仕訳の帳票読み取り）。
 * - `attachments-or-documents`: `context` に加え、画像かテキストの添付が 1 件以上必要（契約書のレビュー）。
 */
export type RowSourceRequirement = 'none' | 'context' | 'attachments' | 'attachments-or-documents';

/** `rows` に渡る入力。 */
export interface RowSourceRowsInput {
  readonly scope: TenantScope;
  /** ノードの config（形の検査は `rows` の責務）。 */
  readonly config: Readonly<Record<string, unknown>>;
  /** 実行文脈の添付。`requirement` が `attachments` なら必ず 1 件以上。 */
  readonly attachments: readonly ResolveAttachment[];
  /** 実行文脈のテキスト添付。`attachments-or-documents` なら画像と合わせて 1 件以上。 */
  readonly documents: readonly ResolveDocument[];
  /**
   * ツールの引数（実行文脈の `arguments`）。文脈の無い呼び出し（保存・スキーマ点検・プレビュー）では空。
   * 省略された引数はキーが無いか null なので、行ソースは既定値に倒し、不正な値は `DataSourceValidationError` で落とす。
   */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 業務が 1 つのノード型について宣言する「行の取り方」。 */
export interface RowSourceResolver {
  /** 書き換える対象のノード型（例: `journal-entries`）。 */
  readonly nodeType: string;
  /** 行に添える固定スキーマ（domain のノードが宣言しているものと同じ値を渡す）。 */
  readonly schema: Schema;
  readonly requirement: RowSourceRequirement;
  /** 行の取り方が配線されていないときの理由。 */
  readonly unavailableMessage: string;
  /** 添付が無いときの理由（`requirement` が `attachments` / `attachments-or-documents` のときだけ使う）。何を添付すればよいかを書く。 */
  readonly missingAttachmentsMessage?: string;
  /**
   * 行を取る。**未配線なら undefined**（composition がポートを渡さなかった）。
   * 設定が不正なら、ポートを呼ぶ前に `DataSourceValidationError` を投げること。
   */
  readonly rows: ((input: RowSourceRowsInput) => Promise<readonly Row[]>) | undefined;
}

/** `missingAttachmentsMessage` を省略したときの理由。 */
export const DEFAULT_MISSING_ATTACHMENTS_MESSAGE = 'no document is attached to this message; attach the document and ask again';

/**
 * ノード型 → 行ソースの表を作る。同じノード型を 2 業務が宣言したら起動時に落とす
 * （黙って後勝ちにすると、どちらの業務の行が出るかが import 順で決まってしまう）。
 */
export function rowSourceTable(resolvers: readonly RowSourceResolver[]): ReadonlyMap<string, RowSourceResolver> {
  const table = new Map<string, RowSourceResolver>();
  for (const resolver of resolvers) {
    if (table.has(resolver.nodeType)) throw new DataSourceValidationError(`row source is registered twice: ${resolver.nodeType}`);
    table.set(resolver.nodeType, resolver);
  }
  return table;
}

/** 1 ノードを登録済みの行ソースで書き換える（規律は冒頭のコメント）。 */
export async function resolveRowSourceNode(resolver: RowSourceResolver, scope: TenantScope, node: GraphNode, context: ResolveGraphContext | undefined): Promise<GraphNode> {
  if (resolver.requirement !== 'none' && context === undefined) return node;
  if (resolver.rows === undefined) throw new DataSourceValidationError(resolver.unavailableMessage);
  const attachments = context?.attachments ?? [];
  const documents = context?.documents ?? [];
  const missing = resolver.requirement === 'attachments'
    ? attachments.length === 0
    : resolver.requirement === 'attachments-or-documents' && attachments.length === 0 && documents.length === 0;
  if (missing) throw new DataSourceValidationError(resolver.missingAttachmentsMessage ?? DEFAULT_MISSING_ATTACHMENTS_MESSAGE);
  const rows = await resolver.rows({ scope, config: node.config as Readonly<Record<string, unknown>>, attachments, documents, arguments: context?.arguments ?? {} });
  return { ...node, type: 'json-source', config: { rows, schema: resolver.schema } };
}
