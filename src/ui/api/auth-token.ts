/**
 * ui/api層: アクセストークンの保管（このブラウザだけ）。
 *
 * サーバーが `AGENTCONTEXT_AUTH_TOKENS` を設定した構成では、全APIリクエストに
 * `Authorization: Bearer <token>` が要る。トークンは利用者が設定画面で貼り付ける想定なので、
 * タブを閉じても消えないよう localStorage に置く。
 *
 * localStorage を使えない環境（プライベートモード等）でも画面が落ちないよう、
 * 読み書きは常に握り潰してメモリ上の値へフォールバックする（そのセッション限りは動く）。
 */
const TOKEN_KEY = 'agentcontext.authToken';

/** localStorage が使えないときの退避先（このタブが開いている間だけ有効）。 */
let fallback: string | undefined;

/** 保存済みトークン。未設定なら `undefined`。 */
export function readAuthToken(): string | undefined {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored !== null && stored !== '') return stored;
  } catch { /* localStorage 不可用: フォールバックを見る */ }
  return fallback;
}

/** トークンを保存する。空文字・undefined は消去と同じ。 */
export function writeAuthToken(token: string | undefined): void {
  const value = token?.trim();
  fallback = value === undefined || value === '' ? undefined : value;
  try {
    if (fallback === undefined) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, fallback);
  } catch { /* localStorage 不可用: メモリ上の値だけで動かす */ }
}

/** トークンを消す（サインアウト相当）。 */
export function clearAuthToken(): void {
  writeAuthToken(undefined);
}
