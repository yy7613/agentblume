/**
 * 業務テンプレートの記述子（ADR-0039）。
 *
 * 業務の画面・一覧のカード・アプリ内ヘルプ・読み込み中の文言を業務ごとの 1 ファイル（`<業務>/<業務>-business.ts`）に
 * 宣言し、App（画面の切り替え）・業務テンプレート一覧・ヘルプはそこから引く。業務を並行して足すときに、
 * 共有の App.tsx / TemplatesPage.tsx / help-content.ts を取り合わないため。
 */
import type { ComponentType } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { BusinessScreenName } from './screen-ids';

/** 日英ペア。表示側が `text(en, ja)` で解決する。 */
export interface Label {
  readonly en: string;
  readonly ja: string;
}

/** 日英ペア（ヘルプの文言）。 */
export type HelpText = Label;

export interface ScreenHelp {
  readonly title: HelpText;
  /** この画面が何をするところか（1-2文）。 */
  readonly summary: HelpText;
  /** ここで何をすればよいか。順番に並べる。 */
  readonly steps: readonly HelpText[];
  /** 参照ドキュメントのリポジトリ内パス（ブラウザからは開けないので文字列として示す）。 */
  readonly doc?: string;
}

/**
 * 業務の画面が受け取る props。HTTP は `client` を `api/<業務>-api.ts` のクライアントへ渡して使う
 * （`ToolApiClient.request` が認証ヘッダ・JSON 解析・`ApiError` への変換を共有する）。
 */
export interface BusinessPageProps {
  readonly client: ToolApiClient;
}

export interface BusinessDescriptor {
  /** 一覧のキー。業務の英小文字名（`journal` / `expense` …）。 */
  readonly id: string;
  /** 開く画面（`business/screen-ids.ts` に列挙済みのもの）。 */
  readonly screen: BusinessScreenName;
  /**
   * 業務テンプレートの一覧に並べるか。**使える状態になるまで false** にしておく
   * （使えない入口は利用者の時間を奪うだけなので。直リンク `#/<画面ID>` では開ける）。
   */
  readonly listed: boolean;
  /** 一覧のカード。`order` は小さいほど前で、業務間で重ねない。 */
  readonly card: { readonly title: Label; readonly summary: Label; readonly order: number };
  /** この画面のアプリ内ヘルプ（左ナビの「ヘルプ」が開く）。 */
  readonly help: ScreenHelp;
  /** 画面を読み込んでいる間に出す文言。 */
  readonly loading: Label;
  /**
   * 画面の読み込み。業務の画面は大きくなるので必ず動的 import にする（App が `lazy` で包む）。
   * 業務の CSS はこの画面のファイルから `import './<業務>.css'` する（共有の styles.css を触らない）。
   */
  readonly loadPage: () => Promise<ComponentType<BusinessPageProps>>;
}
