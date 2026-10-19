const { test, expect } = require("@playwright/test");
const { openApp, waitForServiceWorker, addTortoise } = require("./helpers");

test("app boots in Chrome, service worker takes control, a tortoise can be added", async ({ page, browser }) => {
  expect(browser.version()).toBeTruthy();
  await openApp(page);
  await expect(page).toHaveTitle("Kulalog");
  await waitForServiceWorker(page);
  await addTortoise(page, { name: "Smoke" });
});
