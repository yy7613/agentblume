/**
 * ドメイン共有: 名目的型付け(branded / flavored type)ユーティリティ(ADR-0034)
 *
 * TypeScript の構造的型付けでは `type ToolId = string` のような別名は相互代入可能で、
 * ID の取り違え(ToolId ⇄ AgentId 等)をコンパイル時に検出できない。
 * ここで定義する 2 つの型で名目的な区別を導入する。
 *
 * - `Brand`(強): 素の string/number からの代入を禁止する。生成はスマートコンストラクタ経由のみ。
 * - `Flavor`(弱): 素の string/number からの代入は許すが、異種ブランド間の代入は禁止する。
 *   既存コード・既存テストを変更せずに導入できるため、移行の既定形式(ADR-0034 のラチェット参照)。
 *
 * ブランドプロパティは `unique symbol` のためコンパイル後には存在せず、実行時表現は素の値のまま。
 * `as` によるブランド付与はスマートコンストラクタ内部の 1 箇所のみ許可する。
 */

declare const kind: unique symbol;

/** 強ブランド。素の値は代入不可(スマートコンストラクタでのみ生成)。 */
export type Brand<T, K extends string> = T & { readonly [kind]: K };

/** 弱ブランド。素の値は代入可、異種ブランド間のみ代入不可。 */
export type Flavor<T, K extends string> = T & { readonly [kind]?: K };
