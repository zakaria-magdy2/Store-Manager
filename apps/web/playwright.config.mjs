import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/e2e-browser.spec.mjs'],
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './.playwright-results',
  use: {
    viewport: { width: 1366, height: 768 },
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
