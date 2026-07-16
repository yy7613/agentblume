import { defineConfig, devices } from '@playwright/test';

const uiPort = 5176;
const uiUrl = `http://127.0.0.1:${uiPort}`;

/** デモデータ入りの実画面を再現し、マニュアル画像を更新する専用設定。 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['manual-screenshots.spec.ts', 'harness-tutorial-screenshots.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: uiUrl,
    viewport: { width: 1600, height: 1050 },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
