import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToolApiClient } from './api/tool-api';
import { readAuthToken } from './api/auth-token';
import { SignInGate } from './auth/SignInGate';
import './styles.css';
import { I18nProvider } from './i18n';

const root = document.getElementById('root');
if (root === null) throw new Error('UI root element is missing');

const client = new ToolApiClient();
// トークンは毎リクエスト読み直す。設定画面で入れ替えた直後の呼び出しにも追従させるため。
client.setAuthTokenProvider(readAuthToken);

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      {/* 認証を通してから本体を描く。単一ユーザーモードなら素通りする。 */}
      <SignInGate client={client}>{(session) => <App client={client} session={session} />}</SignInGate>
    </I18nProvider>
  </StrictMode>,
);
