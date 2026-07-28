/**
 * 起動時の認証ゲート。
 *
 * サーバーは `GET /auth/session` で「誰として繋がっているか」を返す。UIはこれ1本で
 * 単一ユーザーモードか、トークンが要る構成かを判別する（401 が返ること自体が合図）。
 *
 * ## なぜアプリ本体より前に置くか
 *
 * 各画面は起動直後に一覧を取りに行く。認証が要る構成でそのまま描画すると、
 * 12個の 401 が別々のカードに出るだけで**何をすればよいか分からない**。
 * 入口で1回だけ聞き、通ってから本体を描く。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AuthSessionDto } from '../api/types';
import { ApiError } from '../api/tool-api';
import { writeAuthToken } from '../api/auth-token';
import { applySessionScope } from '../scope';
import { useI18n } from '../i18n';

/** ゲートの状態。`error` は「サーバーへ届かない」（＝トークンの問題ではない）。 */
type GateState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly session: AuthSessionDto }
  | { readonly kind: 'unauthenticated'; readonly rejected: boolean }
  | { readonly kind: 'error'; readonly message: string };

export function SignInGate({ client, children }: {
  readonly client: ToolApiClient;
  /** 認証を通ったあとに描く本体。セッションを受け取る。 */
  readonly children: (session: AuthSessionDto) => ReactNode;
}) {
  const { text } = useI18n();
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /** `rejected` は「トークンを送ったのに弾かれた」かどうか。初回の未入力と区別して文言を変える。 */
  const check = useCallback(async (rejected: boolean) => {
    try {
      const session = await client.getSession();
      // 以降の全画面が読むスコープはここで確定する（下書きキーと表示に使う）。
      applySessionScope(session.principal);
      setState({ kind: 'ready', session });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setState({ kind: 'unauthenticated', rejected });
        return;
      }
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [client]);

  useEffect(() => { void check(false); }, [check]);

  async function submit(): Promise<void> {
    setSubmitting(true);
    writeAuthToken(token);
    await check(true);
    setSubmitting(false);
  }

  if (state.kind === 'checking') {
    return <main className="workspace-page"><p className="empty-state">{text('Connecting…', '接続しています…')}</p></main>;
  }

  if (state.kind === 'error') {
    return <main className="workspace-page">
      <section className="workspace-card">
        <h1>{text('Cannot reach the API server', 'APIサーバーへ接続できません')}</h1>
        <p className="api-error" role="alert">{state.message}</p>
        <p className="empty-state">{text('Check that the API server is running, then retry.', 'APIサーバーの起動状態を確認して再試行してください。')}</p>
        <button type="button" className="primary" onClick={() => { setState({ kind: 'checking' }); void check(false); }}>{text('Retry', '再試行')}</button>
      </section>
    </main>;
  }

  if (state.kind === 'unauthenticated') {
    return <main className="workspace-page">
      <section className="workspace-card">
        <h1>{text('Access token required', 'アクセストークンが必要です')}</h1>
        <p className="empty-state">
          {text(
            'This server requires authentication. Paste the access token your administrator issued (AGENTCONTEXT_AUTH_TOKENS).',
            'このサーバーは認証を要求しています。管理者が発行したアクセストークン（AGENTCONTEXT_AUTH_TOKENS）を貼り付けてください。',
          )}
        </p>
        {state.rejected && <p className="api-error" role="alert">{text('That token was rejected. Check it and try again.', 'トークンが拒否されました。内容を確認して再試行してください。')}</p>}
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>{text('Access token', 'アクセストークン')}
            <input type="password" autoComplete="off" aria-label={text('Access token', 'アクセストークン')}
              value={token} onChange={(event) => setToken(event.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={submitting || token.trim() === ''}>
            {submitting ? text('Signing in…', '確認中…') : text('Sign in', 'サインイン')}
          </button>
        </form>
      </section>
    </main>;
  }

  return <>{children(state.session)}</>;
}
