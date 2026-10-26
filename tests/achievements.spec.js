// @ts-check
import { test, expect, snapshot, advance, boot, startRun, pickFirstCard, expectValidPlayer } from './fixtures.js';

const ACH_KEY = 'ns_ach_v1';

const achievements = page => page.evaluate(() => window.__neon_test.achievements());
const saved = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), ACH_KEY);

/** Spawns a boss through the test client and kills it. Phase gates hold a boss
    at each threshold for a few ticks, so it takes one hit per phase with time
    advanced in between; the pilot's hull is topped up throughout. */
const killBoss = async (page, type = 'sentinel') => {
  const dead = await page.evaluate(type => {
    const t = window.__neon_test;
    const b = t.boss(type);
    for (let i = 0; i < 40 && !b.dead; i++) {
      t.setHealth(Infinity);
      t.hitEnemy(b, 1e12);
      if (!b.dead) window.advanceTime(250);
    }
    return b.dead;
  }, type);
  expect(dead, `${type} should die`).toBe(true);
};

/** A boss pays out a level-up; take any pending cards so play resumes. */
async function resume(page) {
  for (let i = 0; i < 5 && (await snapshot(page)).mode === 'levelup'; i++) await pickFirstCard(page);
  expect((await snapshot(page)).mode).toBe('playing');
}

/** Records every message the toast element shows, from now on. */
const recordToasts = page => page.evaluate(() => {
  window.__toasts = [];
  const el = document.getElementById('toast');
  new MutationObserver(() => { if (el.textContent) window.__toasts.push(el.textContent); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});
const toasts = page => page.evaluate(() => window.__toasts);

/** Seeds saves before the page's own scripts run, as an older version would have left them. */
const preseed = (page, entries) => page.addInitScript(entries => {
  if (sessionStorage.getItem('__seeded')) return;
  sessionStorage.setItem('__seeded', '1');
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
}, entries);

async function openPanel(page) {
  await page.locator('#achBtn').click();
  await expect(page.locator('#achScreen')).toBeVisible();
  expect((await snapshot(page)).mode).toBe('achievements');
}

test('the registry has 15–20 achievements and the panel lists them all', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#achBtnCount')).toHaveText(/^0\/\d+$/);
  await openPanel(page);
  const rows = page.locator('#achList .achRow');
  const n = await rows.count();
  expect(n).toBeGreaterThanOrEqual(15);
  expect(n).toBeLessThanOrEqual(20);
  await expect(page.locator('#achSummary')).toHaveText(`0/${n} EARNED`);
  const ids = await rows.evaluateAll(els => els.map(el => el.dataset.achId));
  expect(new Set(ids).size).toBe(n);
  // cumulative goals show their progress, everything else is just locked
  await expect(page.locator('[data-ach-id="bosses_25"] .eTag')).toHaveText('0/25');
  await expect(page.locator('[data-ach-id="kills_10k"] .eTag')).toHaveText('0/10,000');
  await expect(page.locator('[data-ach-id="first_boss"] .eTag')).toHaveText('LOCKED');
});

test('a mid-run achievement toasts once, persists at once and survives a reload', async ({ page }) => {
  await startRun(page, { seed: 21 });
  await recordToasts(page);
  await advance(page, 500);
  expect((await achievements(page)).earned).toEqual([]);

  await killBoss(page);
  await advance(page, 100);
  const after = await achievements(page);
  expect(after.earned).toContain('first_boss');
  expect(after.run).toContain('GIANT SLAYER');
  // persisted the moment it was earned, not at the end of the run
  const store = await saved(page);
  expect(store.earned.first_boss).toBe(1);
  expect(store.totals.bosses).toBe(1);

  await expect.poll(async () => (await toasts(page)).filter(t => t.includes('GIANT SLAYER')).length,
    { timeout: 20_000 }).toBe(1);
  expect((await toasts(page)).find(t => t.includes('GIANT SLAYER'))).toBe('★ ACHIEVEMENT — GIANT SLAYER · Destroy a boss');

  // a second boss is not a second first boss
  await resume(page);
  await killBoss(page, 'juggernaut');
  await advance(page, 1000);
  expect((await achievements(page)).run.filter(n => n === 'GIANT SLAYER')).toHaveLength(1);

  await page.reload();
  await expect(page.locator('#startBtn')).toBeVisible();
  const reloaded = await achievements(page);
  expect(reloaded.earned).toContain('first_boss');
  expect(reloaded.totals.bosses).toBe(2);
  await openPanel(page);
  await expect(page.locator('[data-ach-id="first_boss"]')).toHaveClass(/earned/);
  await expect(page.locator('[data-ach-id="first_boss"] .eTag')).toHaveText('EARNED');
  await expect(page.locator('[data-ach-id="bosses_25"] .eTag')).toHaveText('2/25');
  await page.keyboard.press('Escape');

  // and it never fires again
  await page.locator('#startBtn').click();
  await recordToasts(page);
  await killBoss(page);
  await advance(page, 1000);
  expect((await achievements(page)).run).not.toContain('GIANT SLAYER');
  await page.waitForTimeout(6000);
  expect((await toasts(page)).some(t => t.includes('GIANT SLAYER'))).toBe(false);
});

test('a career goal completes mid-run from the saved total plus this run', async ({ page }) => {
  await preseed(page, { [ACH_KEY]: JSON.stringify({ earned: {}, totals: { kills: 0, bosses: 24 }, wins: {} }) });
  await startRun(page, { seed: 3 });
  expect((await achievements(page)).earned).not.toContain('bosses_25');
  await killBoss(page);
  await advance(page, 100);
  expect((await achievements(page)).earned).toContain('bosses_25');
  expect((await saved(page)).totals.bosses).toBe(25);
});

test('UNTOUCHABLE needs a boss fight with no hull lost', async ({ page }) => {
  await startRun(page, { seed: 31 });
  /** Kills a fresh boss behind i-frames, after optionally losing some hull to it. */
  const fight = hurt => page.evaluate(hurt => {
    const t = window.__neon_test;
    t.clearThreats();
    const b = t.boss('sentinel');
    if (hurt) t.hitPlayer(5);         // STRIKER has no shield, so this is hull
    for (let i = 0; i < 40 && !b.dead; i++) {
      t.setHealth(Infinity);
      t.player().invT = 1e9;
      t.hitEnemy(b, 1e12);
      if (!b.dead) window.advanceTime(250);
    }
    t.player().invT = 0;
    return b.dead;
  }, hurt);

  expect(await fight(true)).toBe(true);
  await advance(page, 100);
  const hurt = await achievements(page);
  expect(hurt.earned).toContain('first_boss');
  expect(hurt.earned).not.toContain('flawless_boss');

  await resume(page);
  expect(await fight(false)).toBe(true);
  await advance(page, 100);
  expect((await achievements(page)).earned).toContain('flawless_boss');
});

test('the run-end achievements appear on the result screen', async ({ page }) => {
  await boot(page);
  await page.locator('#diffRow .diffBtn[data-diff-id="recruit"]').click();
  await page.locator('#startBtn').click();
  await expect.poll(async () => (await snapshot(page)).mode).toBe('playing');
  await page.evaluate(() => window.__neon_test.setElapsed(725));
  await killBoss(page, 'architect');

  expect((await snapshot(page)).mode).toBe('gameover');
  await expect(page.locator('#gameoverScreen')).toBeVisible();
  const note = page.locator('#achNote');
  await expect(note).toBeVisible();
  await expect(note).toContainText('PURGED · RECRUIT');
  // the win also unlocked ECHO, which earns the pilot-unlock achievement
  await expect(note).toContainText('NEW BLOOD');
  const a = await achievements(page);
  expect(a.earned).toEqual(expect.arrayContaining(['win_recruit', 'first_boss', 'pilot_unlock', 'survive_5']));
  expect(a.earned).not.toContain('win_veteran');
  expect(a.wins).toEqual([(await snapshot(page)).player.pilot]);
  expect((await saved(page)).earned.win_recruit).toBe(1);

  // a run with nothing new hides the line again
  await page.locator('#restartBtn').click();
  for (let i = 0; i < 20 && (await snapshot(page)).mode !== 'gameover'; i++) {
    await page.evaluate(() => window.__neon_test.hitPlayer(1e6));
  }
  await expect(page.locator('#gameoverScreen')).toBeVisible();
  await expect(note).toBeHidden();
});

test('saves from before achievements grant what they already prove', async ({ page }) => {
  await preseed(page, {
    ns_win_veteran: '1',
    ns_unlock_warden: '1',
    ns_best_time_nightmare: '312.5',
  });
  await boot(page);
  const a = await achievements(page);
  expect(a.earned).toEqual(expect.arrayContaining(['first_boss', 'level_10', 'survive_5', 'win_veteran', 'pilot_unlock']));
  for (const id of ['win_recruit', 'win_nightmare', 'full_roster', 'first_evo', 'ace']) expect(a.earned).not.toContain(id);
  expect((await saved(page)).earned.win_veteran).toBe(1);
  await expect(page.locator('#achBtnCount')).toHaveText(new RegExp(`^${a.earned.length}/`));
  // the old keys are left exactly as they were
  expect(await page.evaluate(() => [localStorage.getItem('ns_win_veteran'), localStorage.getItem('ns_unlock_warden')])).toEqual(['1', '1']);
  await openPanel(page);
  await expect(page.locator('[data-ach-id="full_roster"] .eTag')).toHaveText('1/3');
});

test('a corrupt save is ignored and replaced cleanly', async ({ page }) => {
  await preseed(page, { [ACH_KEY]: '{not json' });
  await startRun(page, { seed: 5 });
  expect((await achievements(page)).earned).toEqual([]);
  await killBoss(page);
  await advance(page, 100);
  expect((await saved(page)).earned.first_boss).toBe(1);
});

test('with localStorage throwing on every call the game still boots, plays and ends a run', async ({ page }) => {
  await page.addInitScript(() => {
    const boom = () => { throw new DOMException('denied', 'SecurityError'); };
    for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) Storage.prototype[m] = boom;
    Object.defineProperty(window, 'localStorage', { get: boom });
  });
  await startRun(page, { seed: 9 });
  await advance(page, 1000);
  await killBoss(page);
  await advance(page, 1000);
  expect((await achievements(page)).earned).toContain('first_boss');
  await resume(page);
  await advance(page, 1000);
  expectValidPlayer(await snapshot(page));

  for (let i = 0; i < 20 && (await snapshot(page)).mode !== 'gameover'; i++) {
    await page.evaluate(() => window.__neon_test.hitPlayer(1e6));
  }
  await expect(page.locator('#gameoverScreen')).toBeVisible();
  await expect(page.locator('#achNote')).toContainText('GIANT SLAYER');
  await page.locator('#menuBtn').click();
  await openPanel(page);
  await expect(page.locator('[data-ach-id="first_boss"]')).toHaveClass(/earned/);
  // the fixture fails the test on any console or page error
});

test('achievement checks never draw from the simulation RNG', async ({ page }) => {
  // The first pass earns GIANT SLAYER mid-run; the replay, after
  // a reload, has them saved already, so its checks skip. Same seed, same inputs:
  // same snapshots.
  const play = async () => {
    await page.evaluate(() => window.__neon_test.seed(4711));
    await page.locator('#startBtn').click();
    const snaps = [];
    await advance(page, 1000);
    await killBoss(page);
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__neon_test.setHealth(Infinity));
      await advance(page, 1000);
      const snap = await snapshot(page);
      snaps.push(snap);
      if (snap.mode !== 'playing') break;
    }
    return snaps;
  };
  await boot(page);
  const first = await play();
  expect((await achievements(page)).run).toContain('GIANT SLAYER');
  await boot(page);
  const replay = await play();
  expect((await achievements(page)).earned).toContain('first_boss');
  expect((await achievements(page)).run).toEqual([]);
  expect(replay).toEqual(first);
});

test('the panel is keyboard navigable, traps focus and returns it', async ({ page }) => {
  await boot(page);
  await page.locator('#achBtn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#achScreen')).toBeVisible();
  await expect(page.locator('#startScreen')).toBeHidden();
  await expect(page.locator('#closeAchBtn')).toBeFocused();
  // Enter on the panel must not start a run behind it
  expect((await snapshot(page)).mode).toBe('achievements');

  const rows = await page.locator('#achList .achRow').count();
  await page.keyboard.press('Tab');
  await expect(page.locator('#achList .achRow').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#closeAchBtn')).toBeFocused();
  for (let i = 0; i < rows + 3; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('achScreen').contains(document.activeElement))).toBe(true);
  }
  // the focused row is scrolled into view inside the list
  const focusedInView = await page.evaluate(() => {
    const el = document.activeElement, list = document.getElementById('achList');
    if (!list.contains(el)) return true;
    const a = el.getBoundingClientRect(), b = list.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  });
  expect(focusedInView).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('#achScreen')).toBeHidden();
  await expect(page.locator('#startScreen')).toBeVisible();
  await expect(page.locator('#achBtn')).toBeFocused();
  expect((await snapshot(page)).mode).toBe('start');

  // the close button works the same way
  await page.keyboard.press('Enter');
  await expect(page.locator('#achScreen')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#achScreen')).toBeHidden();
  await expect(page.locator('#achBtn')).toBeFocused();
});

test('the panel is fully usable with a gamepad', async ({ page }) => {
  await page.addInitScript(() => {
    const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  const tap = async button => {
    await page.evaluate(b => { window.__pad.buttons[b].pressed = true; }, button);
    await page.waitForTimeout(120);
    await page.evaluate(b => { window.__pad.buttons[b].pressed = false; }, button);
    await page.waitForTimeout(120);
  };
  const A = 0, B = 1, DOWN = 13;

  await boot(page);
  await page.locator('#startBtn').focus();
  await tap(DOWN);
  await expect(page.locator('#achBtn')).toBeFocused();
  await tap(A);
  await expect(page.locator('#achScreen')).toBeVisible();
  await expect(page.locator('#closeAchBtn')).toBeFocused();

  // down from CLOSE wraps to the first row, and keeps walking the list
  await tap(DOWN);
  await expect(page.locator('#achList .achRow').nth(0)).toBeFocused();
  await tap(DOWN);
  await expect(page.locator('#achList .achRow').nth(1)).toBeFocused();

  await tap(B);
  await expect(page.locator('#achScreen')).toBeHidden();
  await expect(page.locator('#achBtn')).toBeFocused();
  expect((await snapshot(page)).mode).toBe('start');

  // and A on CLOSE closes it too
  await tap(A);
  await expect(page.locator('#achScreen')).toBeVisible();
  await tap(A);
  await expect(page.locator('#achScreen')).toBeHidden();
});

for (const size of [{ width: 1280, height: 720 }, { width: 358, height: 740 }]) {
  test(`the panel fits at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await boot(page);
    await page.locator('#achBtn').scrollIntoViewIfNeeded();
    await openPanel(page);
    const layout = await page.evaluate(() => {
      const list = document.getElementById('achList');
      const close = document.getElementById('closeAchBtn').getBoundingClientRect();
      const rows = [...list.querySelectorAll('.achRow')].map(r => r.getBoundingClientRect());
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        listOverflowX: list.scrollWidth - list.clientWidth,
        screenOverflowX: document.getElementById('achScreen').scrollWidth - window.innerWidth,
        rowsInside: rows.every(r => r.left >= 0 && r.right <= window.innerWidth),
        close: { top: close.top, bottom: close.bottom, left: close.left, right: close.right },
      };
    });
    expect(layout.listOverflowX).toBeLessThanOrEqual(0);
    expect(layout.screenOverflowX).toBeLessThanOrEqual(0);
    expect(layout.rowsInside).toBe(true);
    // CLOSE is on screen without scrolling the overlay
    expect(layout.close.top).toBeGreaterThanOrEqual(0);
    expect(layout.close.bottom).toBeLessThanOrEqual(layout.vh);
    expect(layout.close.left).toBeGreaterThanOrEqual(0);
    expect(layout.close.right).toBeLessThanOrEqual(layout.vw);
  });
}
