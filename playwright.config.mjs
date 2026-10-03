import { defineConfig } from "playwright/test";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

const ignoreHTTPSErrors =
  process.env.AUDIT_IGNORE_HTTPS_ERRORS === "1" ||
  /^https:\/\/127\.0\.0\.1(?::\d+)?$/i.test(baseURL);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL,
    ignoreHTTPSErrors,
    trace: "off",
    screenshot: "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      // WebKit covers the auth layout and the UX-refactor surfaces too, so the
      // webkit jobs can never pass vacuously on a spec they do not match.
      testMatch:
        /(ui-system|clients-v2|orders-v2|password-field|dashboard-ux)\.spec\.mjs/,
    },
  ],
});
