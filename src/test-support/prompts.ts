/**
 * テスト補助: 同梱のプロンプト（`<repo>/prompts`）を読むカタログ（v48 実装契約 §4）。
 *
 * ## なぜテストが実ファイルを読むのか
 *
 * 文をファイルへ移したあと、テストの中に文の写しを置くと**二重管理**になる（文を直したのに
 * テストの期待値だけ古い、が起きる）。テストは同梱の実ファイルを読み、「文を直せばテストがそれを見る」
 * 状態を保つ。だから偽物のカタログではなく `FsPromptCatalog` をそのまま使う。
 *
 * ## 環境変数を無視する理由
 *
 * `AGENTCONTEXT_PROMPTS_DIR` は運用者の上書きで、開発者の手元にも設定されていることがある。
 * それを読むとテストの結果が各自の環境に依存してしまうので、ここでは**同梱だけ**を読む。
 * 置き場所はリポジトリからの相対（`import.meta.url` 起点）で、実行時の cwd にも依存しない。
 */
import { fileURLToPath } from 'node:url';
import { FsPromptCatalog } from '../adapters/prompts/fs-prompt-catalog';

/** `<repo>/prompts` の絶対パス。 */
export const BUNDLED_PROMPTS_DIRECTORY = fileURLToPath(new URL('../../prompts', import.meta.url));

/** 1 テストファイルにつき 1 つあれば足りる（`get` は更新時刻を見て読み直すので古くならない）。 */
let cached: FsPromptCatalog | undefined;

/** 同梱のプロンプトを読むカタログ。同期で使える。 */
export function bundledPrompts(): FsPromptCatalog {
  cached ??= new FsPromptCatalog({ directories: [BUNDLED_PROMPTS_DIRECTORY], env: {} });
  return cached;
}
