// @ts-check
import { test, expect, snapshot, advance, startRun, pickFirstCard, expectValidPlayer } from './fixtures.js';

/** Plays a fixed script and returns every per-second snapshot: hull topped up,
    one simulated second at a time, a forced level-up every fifth second so
    offers are rolled, and the first card taken at each level-up. */
async function playScript(page, seconds) {
  const snaps = [];
  for (let i = 0; i < seconds; i++) {
    await page.evaluate(() => window.__neon_test.setHealth(Infinity));
    await advance(page, 1000);
    if (i % 5 === 4 && (await snapshot(page)).mode === 'playing') {
      await page.evaluate(() => window.__neon_test.levelUp());
    }
    const snap = await snapshot(page);
    snaps.push(snap);
    if (snap.mode === 'levelup') await pickFirstCard(page);
    else expect(snap.mode).toBe('playing');
  }
  return snaps;
}

async function seededRun(page, seed, seconds = 25) {
  await startRun(page, { seed });
  return playScript(page, seconds);
}

test('full hull reports hp equal to maxHp at the same precision', async ({ page }) => {
  await startRun(page, { seed: 1 });
  // Stacked Reinforced Chassis leaves a fractional max hull (e.g. 129.404).
  await page.evaluate(() => {
    window.__neon_test.upgrade('bulwark', 2);
    window.__neon_test.upgrade('bulwark', 3);
  });
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__neon_test.setHealth(Infinity));
    const snap = await snapshot(page);
    expect(snap.player.hp).toBe(snap.player.maxHp);
    expectValidPlayer(snap);
    await page.evaluate(() => window.__neon_test.upgrade('bulwark', 1));
  }
});

test('the same seed and inputs replay the same run; another seed diverges', async ({ page }) => {
  const first = await seededRun(page, 12345);
  const replay = await seededRun(page, 12345);
  expect(replay).toEqual(first);

  // The script must actually exercise the RNG: kills, spawns and offers.
  const end = first[first.length - 1];
  expect(end.player.kills).toBeGreaterThan(0);
  expect(first.some(s => s.offers.length > 0)).toBe(true);

  const other = await seededRun(page, 54321);
  expect(other).not.toEqual(first);
});

test('a seed set before load through __vt_seed pins the run too', async ({ page }) => {
  const viaHook = await seededRun(page, 777, 10);
  await page.addInitScript(() => { window.__vt_seed = 777; });
  await startRun(page);
  expect(await playScript(page, 10)).toEqual(viaHook);
});

test('cosmetic randomness never advances the simulation stream', async ({ page }) => {
  // Reduced motion halves particle bursts and drops muzzle sparks, so it changes
  // how many cosmetic draws happen. A seeded run must not notice.
  const full = await seededRun(page, 4242, 10);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await seededRun(page, 4242, 10)).toEqual(full);
});

test('the live page exposes no test hooks and still plays', async ({ browser }) => {
  // A fresh page without the fixture's __vt_pending init script.
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto('/index.html');
  await page.locator('#startBtn').click();
  await expect.poll(async () => (await snapshot(page)).mode).toBe('playing');
  await expect.poll(async () => (await snapshot(page)).elapsed).toBeGreaterThan(0.5);
  expect(await page.evaluate(() => ['__neon_test', 'simRandom', 'fxRand', 'pinnedSeed', 'seedSim', 'mulberry32']
    .filter(k => k in window))).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});
