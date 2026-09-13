import { test as base } from "@playwright/test";

/** This sandbox's outbound network policy blocks fonts.googleapis.com /
 *  fonts.gstatic.com (the app's Google Fonts <link>) at the proxy level —
 *  but as a hung connection rather than a fast failure, which was quietly
 *  stalling later, unrelated `page.goto` calls (their CDP round-trip
 *  waiting behind a backlog of never-resolving font requests) well past
 *  when the target page had actually finished loading. Aborting those
 *  requests outright, before the browser ever tries them, removes the
 *  hang entirely — same idea as a real CI runner with restricted
 *  internet access. Harmless everywhere else: the app still renders with
 *  its fallback system fonts. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await use(page);
  },
});

export { expect } from "@playwright/test";
