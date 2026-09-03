import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Headless always, and `webServer` starts both halves of the product so a run
 * is one command. The API seeds a fixed workspace with fixed ids (see
 * `tools/dev-server.ts`) — a UI test that has to first discover what is in the
 * workspace fails for two different reasons and cannot tell you which.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tools/dev-server.ts --port 8788',
      url: 'http://127.0.0.1:8788/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // The development identity provider, so `/v1/auth/session` accepts
      // `dev:<email>` and the sharing walkthroughs can actually sign people in.
      env: { GALLEY_TOKEN_FILE: '.galley-e2e-tokens.json', GALLEY_DEV_AUTH: '1' },
    },
    {
      command: 'npx vite --port 5174 --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      cwd: 'apps/web',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { GALLEY_API: 'http://127.0.0.1:8788' },
    },
  ],
});
