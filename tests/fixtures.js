// @ts-check
import { test as base, expect } from '@playwright/test';

/* Every spec boots the real index.html in the deterministic test client:
   `__vt_pending` makes the page expose `window.__neon_test` and keeps the rAF
   loop from advancing the simulation, so time only moves through
   `window.advanceTime(ms)`. Google Fonts is stubbed so runs are hermetic, and
   any console error or uncaught page error fails the test. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));

    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.addInitScript(() => { window.__vt_pending = true; });

    await use(page);

    expect(errors, 'page logged errors during the test').toEqual([]);
  },
});

export { expect };

/** Parsed `render_game_to_text()` snapshot. */
export const snapshot = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));

export const advance = (page, ms) => page.evaluate(t => window.advanceTime(t), ms);

export async function boot(page) {
  await page.goto('/index.html');
  await expect(page.locator('#startBtn')).toBeVisible();
}

/** Starts a run; a `seed` pins the simulation RNG so the run is reproducible. */
export async function startRun(page, { seed } = {}) {
  await boot(page);
  if (seed !== undefined) await page.evaluate(n => window.__neon_test.seed(n), seed);
  await page.locator('#startBtn').click();
  await expect.poll(async () => (await snapshot(page)).mode).toBe('playing');
}

/** Picks the first offer once the cards' anti-misclick lock has lifted. */
export async function pickFirstCard(page) {
  await expect(page.locator('#cardsWrap')).not.toHaveClass(/locked/);
  await page.locator('#cardsWrap .card').first().click();
}

/** Asserts the numbers a soft-lock or bad maths would corrupt are all finite. */
export function expectValidPlayer(snap) {
  const p = snap.player;
  for (const [key, value] of Object.entries({ x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, xp: p.xp, score: p.score, elapsed: snap.elapsed })) {
    expect(Number.isFinite(value), `${key} should be finite, got ${value}`).toBe(true);
  }
  expect(p.hp).toBeGreaterThanOrEqual(0);
  expect(p.hp).toBeLessThanOrEqual(p.maxHp);
}
