/**
 * Composition: 業務（仕訳・経費精算・入金消込・契約）を組み立てる関数が受け取る文脈と、返す形（ADR-0039）。
 *
 * 業務の組み立ては `composition/<業務>.ts` の `compose<業務>(context)` に閉じ、`root.ts` は並べて呼ぶだけにする。
 * 業務を並行して足すときに、共有の `root.ts`（リポジトリ選択・ユースケース生成・App 型）を取り合わないため。
 *
 * 文脈に載せるのは「業務が共通基盤から借りるもの」だけ。ここに無いもの（Agent 実行など、データソース解決の
 * 後にしか作れないもの）が要るなら、`root.ts` の組み立て順ごと見直す必要がある（ADR-0039 の帰結）。
 */
import type { SqliteDatabase } from '../adapters/storage/sqlite-database';
import type { RowSourceResolver } from '../application/data-source/row-sources';
import type { ModelCapability, ModelProviderPort } from '../application/model/model-provider';
import type { SecretCipherPort } from '../application/model-settings/secret-cipher';
import type { LoggerPort } from '../application/operations/logger';
import type { UnitOfWorkPort } from '../application/persistence/unit-of-work';
import type { PromptCatalogPort } from '../application/prompt/prompt-catalog-port';
import type { ExperimentModelSnapshot } from '../domain/evaluation/experiment';

export interface BusinessCompositionContext {
  /** `test` は InMemory リポジトリと缶詰モデル。LLM 機能の可否は決定的に「使えない」へ倒すこと。 */
  readonly profile: 'local' | 'test';
  /** local は共有 SQLite 接続（マイグレーション適用済み）で、test は InMemory で実装を作る。 */
  readonly pickRepository: <T>(sqlite: (db: SqliteDatabase) => T, memory: () => T) => T;
  /** 複数リポジトリにまたがる書き込みを 1 トランザクションで括る（test 配線では no-op）。 */
  readonly unitOfWork: UnitOfWorkPort;
  /** main スロットのモデル（切替可能な配線ならその実体）。 */
  readonly modelProvider: ModelProviderPort;
  /** main スロットにモデルが設定されているか（能力ではなく**設定の有無**）。test は常に false。 */
  readonly mainModelConfigured: () => Promise<boolean>;
  /** 保存済み設定を解決してから main モデルの能力を読む（UI から設定が変わるので毎回呼ぶ）。 */
  readonly mainModelCapabilities: () => Promise<readonly ModelCapability[]>;
  /** 実行時点のモデル指紋。切替可能な配線でだけ定義される。 */
  readonly resolveModelSnapshot?: () => Promise<ExperimentModelSnapshot>;
  /** 握り潰した障害の出力先。 */
  readonly errorLogger: LoggerPort;
  /**
   * モデルへ送る指示文のカタログ（v48 / ADR-0052）。仕訳・経費・契約の LLM 読み取り / ヒアリング / 審査が
   * `PromptCatalogPort` を受けてプロンプトファイルの文を組み立てる。`root.ts` が起動時に 1 つ作って渡す。
   */
  readonly promptCatalog: PromptCatalogPort;
  /**
   * 秘密値・個人情報の封緘（モデル設定・MCP 設定と同じ鍵。鍵は DB の外）。経費精算の振込口座番号が使う（docs/21 §20.17-1）。
   * 省略可にしてあるのは、この文脈を直接組み立てる既存のテストを壊さないため。省略された業務は揮発鍵で動かす。
   */
  readonly secretCipher?: SecretCipherPort;
}

/** 業務の組み立て結果。 */
export interface BusinessComposition<Feature> {
  /** App に交差させる部分（api の `<業務>RouteDeps` をそのまま満たす）。 */
  readonly feature: Feature;
  /** ツール実行の直前に行を差し込むノード（`application/data-source/row-sources.ts`）。 */
  readonly rowSources: readonly RowSourceResolver[];
}
