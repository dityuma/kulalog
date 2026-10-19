// @ts-check
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8090;

// Every browser test runs in the installed Google Chrome (channel "chrome"), not the bundled Chromium,
// once in a desktop window and once with Chrome's Android emulation of a Pixel 7.
module.exports = defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    channel: "chrome",
    serviceWorkers: "allow",
    timezoneId: "Asia/Jakarta",
    locale: "en-GB",
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 800 } } },
    { name: "pixel-7", use: { ...devices["Pixel 7"], channel: "chrome" } }
  ],
  webServer: {
    command: `node serve.js ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true
  }
});
