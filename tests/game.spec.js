// @ts-check
import { test, expect, snapshot, advance, boot, startRun, pickFirstCard, expectValidPlayer } from './fixtures.js';

const TICK = 1 / 60;

/** Total upgrade stacks shown in the level-up build strip; evolutions count as one. */
const buildStacks = page => page.locator('#buildStrip .bsChip').evaluateAll(chips =>
  chips.reduce((n, chip) => n + (chip.classList.contains('evo') ? 1 : Number(chip.querySelector('b')?.textContent.slice(1) || 0)), 0));

test('boot shows the menu with a pilot and difficulty', async ({ page }) => {
  await boot(page);
  const snap = await snapshot(page);
  expect(snap.mode).toBe('start');
  expect(typeof snap.selectedPilot).toBe('string');
  expect(snap.selectedPilot.length).toBeGreaterThan(0);
  expect(typeof snap.difficulty).toBe('string');
  expect(snap.difficulty.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => typeof window.__neon_test)).toBe('object');
});

test('starting a run enters play and advanceTime moves the clock', async ({ page }) => {
  await boot(page);
  const menu = await snapshot(page);
  await page.locator('#startBtn').click();
  const before = await snapshot(page);
  expect(before.mode).toBe('playing');
  expect(before.player.pilot).toBe(menu.selectedPilot);
  expect(before.difficulty).toBe(menu.difficulty);
  expectValidPlayer(before);

  await advance(page, 1000);
  const after = await snapshot(page);
  expect(after.mode).toBe('playing');
  expect(after.elapsed - before.elapsed).toBeGreaterThanOrEqual(1 - 2 * TICK);
  expect(after.elapsed - before.elapsed).toBeLessThanOrEqual(1 + 2 * TICK);
});

test('keyboard Enter on the focused start button also starts a run', async ({ page }) => {
  await boot(page);
  await page.locator('#startBtn').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snapshot(page)).mode).toBe('playing');
});

test('combat progresses and the state stays valid', async ({ page }) => {
  await startRun(page, { seed: 0xC0FFEE });
  const start = await snapshot(page);

  // Twenty simulated seconds, one second at a time. Keep the pilot alive so the
  // test measures progression rather than the RNG, and take any level-up offered.
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__neon_test.setHealth(Infinity));
    await advance(page, 1000);
    const snap = await snapshot(page);
    if (snap.mode === 'levelup') await pickFirstCard(page);
    else expect(snap.mode).toBe('playing');
    expectValidPlayer(snap);
  }

  const end = await snapshot(page);
  expect(end.elapsed).toBeGreaterThan(start.elapsed + 15);
  expect(end.player.kills).toBeGreaterThan(start.player.kills);
  expect(end.player.score).toBeGreaterThan(start.player.score);
  // The pilot stands still, so drops can land out of pickup range: XP collected
  // or gems left on the field both show kills feed progression.
  expect(end.player.level > start.player.level || end.player.xp > start.player.xp || end.counts.gems > 0).toBe(true);
});

test('level-up offers apply the picked card and resume play', async ({ page }) => {
  await startRun(page);
  const levelBefore = (await snapshot(page)).player.level;

  await page.evaluate(() => window.__neon_test.levelUp());
  await expect(page.locator('#levelupScreen')).toBeVisible();
  const stacksBefore = await buildStacks(page);
  const offered = await snapshot(page);
  expect(offered.mode).toBe('levelup');
  expect(offered.offers.length).toBeGreaterThan(0);
  expect(offered.offers.length).toBeLessThanOrEqual(3);
  for (const o of offered.offers) expect(typeof o.id).toBe('string');

  // Time must not pass while the choice is open.
  await advance(page, 500);
  expect((await snapshot(page)).elapsed).toBe(offered.elapsed);

  await pickFirstCard(page);
  await expect(page.locator('#levelupScreen')).toBeHidden();
  const after = await snapshot(page);
  expect(after.mode).toBe('playing');
  expect(after.offers).toEqual([]);
  expect(after.resources.pendingLevels).toBe(0);
  expect(after.player.level).toBe(levelBefore);

  await advance(page, 500);
  expect((await snapshot(page)).elapsed).toBeGreaterThan(after.elapsed);

  // The next level-up's build strip shows the picked card was applied.
  await page.evaluate(() => window.__neon_test.levelUp());
  await expect(page.locator('#levelupScreen')).toBeVisible();
  expect(await buildStacks(page)).toBeGreaterThan(stacksBefore);
});

test('pause freezes the clock and resume continues it', async ({ page }) => {
  await startRun(page);
  await advance(page, 500);

  await page.keyboard.press('p');
  await expect(page.locator('#pauseScreen')).toBeVisible();
  const paused = await snapshot(page);
  expect(paused.mode).toBe('paused');
  await advance(page, 2000);
  expect((await snapshot(page)).elapsed).toBe(paused.elapsed);

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#pauseScreen')).toBeHidden();
  expect((await snapshot(page)).mode).toBe('playing');
  await advance(page, 1000);
  expect((await snapshot(page)).elapsed).toBeGreaterThan(paused.elapsed + 1 - 2 * TICK);

  // The HUD button pauses too.
  await page.locator('#pauseBtn').click();
  expect((await snapshot(page)).mode).toBe('paused');
  await page.keyboard.press('p');
  expect((await snapshot(page)).mode).toBe('playing');
});

test('lethal damage reaches game over and retry starts a fresh run', async ({ page }) => {
  await startRun(page);
  await advance(page, 3000);

  // Shields and one-off revives absorb hits, so keep hitting until the run ends.
  for (let i = 0; i < 20 && (await snapshot(page)).mode !== 'gameover'; i++) {
    await page.evaluate(() => window.__neon_test.hitPlayer(1e6));
  }
  expect((await snapshot(page)).mode).toBe('gameover');
  await expect(page.locator('#gameoverScreen')).toBeVisible();

  await advance(page, 1000);
  expect((await snapshot(page)).mode).toBe('gameover');

  await page.locator('#restartBtn').click();
  await expect(page.locator('#gameoverScreen')).toBeHidden();
  const fresh = await snapshot(page);
  expect(fresh.mode).toBe('playing');
  expect(fresh.elapsed).toBe(0);
  expect(fresh.player.kills).toBe(0);
  expect(fresh.player.score).toBe(0);
  expect(fresh.player.hp).toBe(fresh.player.maxHp);
  expectValidPlayer(fresh);
});

for (const type of ['sentinel', 'juggernaut', 'swarmcaller', 'voidreaper', 'architect']) {
  test(`boss spawn: ${type}`, async ({ page }) => {
    await startRun(page, { seed: 0xB055 });
    const expectedName = await page.evaluate(t => {
      window.__neon_test.boss(t);
      return window.__neon_test.enemies().find(e => e.boss && !e.dead).bossName;
    }, type);

    const spawned = await snapshot(page);
    expect(spawned.boss).not.toBeNull();
    expect(spawned.boss.name).toBe(expectedName);
    expect(spawned.boss.hp).toBeGreaterThan(0);
    expect(spawned.boss.hp).toBeLessThanOrEqual(spawned.boss.maxHp);

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__neon_test.setHealth(Infinity));
      await advance(page, 1000);
      const snap = await snapshot(page);
      if (snap.mode === 'levelup') await pickFirstCard(page);
      else expect(snap.mode).toBe('playing');
      expectValidPlayer(snap);
      if (snap.boss) {
        expect(Number.isFinite(snap.boss.hp)).toBe(true);
        expect(snap.boss.phase).toBeGreaterThanOrEqual(1);
      }
    }
  });
}
