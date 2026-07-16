import { defineConfig, devices } from '@playwright/test';

const apiPort = 3035;
const uiPort = 5175;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}`;

export default defineConfig({
  testDir: './e2e',
  // デモ画像生成は、sample dataを起動する playwright.manual.config.ts 専用とする。
  testIgnore: ['**/manual-screenshots.spec.ts', '**/harness-tutorial-screenshots.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === undefined ? 0 : 2,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: uiUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      name: 'api',
      command: 'npm run serve',
      url: `${apiUrl}/health`,
      env: {
        AGENTCONTEXT_PROFILE: 'test',
        AGENTCONTEXT_PORT: String(apiPort),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'ui',
      command: `npm run dev:ui -- --port ${uiPort} --strictPort`,
      url: uiUrl,
      env: { AGENTCONTEXT_API_URL: apiUrl },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
