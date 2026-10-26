// @ts-check
import { test, expect, snapshot, advance, startRun, pickFirstCard, expectValidPlayer } from './fixtures.js';

const TIP = 'NEW THREAT — CONDUIT: shields the enemies around it. Kill it first';
const CONDUIT_DR = 0.4;
const DR_CAP = 0.6;
const ARMORED = { key: 'armored', name: 'ARMORED', color: '#8fb6d6', hp: 2.5, speed: 0.80, dmg: 1.15, dr: 0.26 };

/** Clears the field and spawns a conduit with a test pack beside the player.
    Everything is given a deep HP pool so auto-fire cannot kill it mid-test; the
    pack is published on `window.__pack` for later evaluates. */
async function spawnPack(page, extra = {}) {
  await page.evaluate(({ extra }) => {
    const t = window.__neon_test;
    t.clearThreats();
    t.setHealth(Infinity);
    const p = t.player();
    const at = (dx, dy) => ({ pos: { x: p.x + dx, y: p.y + dy }, hp: 1e6 });
    window.__pack = {
      conduit: t.spawn('conduit', at(300, 0)),
      near: t.spawn('grunt', at(220, -40)),
      near2: t.spawn('grunt', at(220, 40)),
      far: t.spawn('grunt', at(-300, 0)),
    };
    for (const [key, spec] of Object.entries(extra)) {
      window.__pack[key] = spec.boss
        ? Object.assign(t.boss(spec.boss), { x: p.x + spec.dx, y: p.y + spec.dy })
        : t.spawn(spec.type, { ...at(spec.dx, spec.dy), elite: spec.elite });
    }
  }, { extra });
}

/** Advances `ms` with an oversized hull topped up every 100ms: a level-1 pilot
    dropped into a 4:40 field would otherwise be one-shot by the first bomber. */
const survive = (page, ms) => page.evaluate(ms => {
  window.__neon_test.player().maxHealth = 1e7;
  for (let t = 0; t < ms; t += 100) {
    window.__neon_test.setHealth(Infinity);
    window.advanceTime(Math.min(100, ms - t));
  }
}, ms);

/** HP one `hitEnemy(value)` removes from each named member of the pack. */
const hitEach = (page, names, value) => page.evaluate(({ names, value }) => {
  const t = window.__neon_test;
  const out = {};
  for (const n of names) {
    const e = window.__pack[n];
    const before = e.hp;
    t.hitEnemy(e, value);
    out[n] = before - e.hp;
  }
  return out;
}, { names, value });

test('a tethered ally takes reduced damage until its conduit dies', async ({ page }) => {
  await startRun(page, { seed: 11 });
  await spawnPack(page);
  await advance(page, 500);

  const linked = await page.evaluate(() => {
    const { conduit, near, near2, far } = window.__pack;
    return { links: conduit.links.length, near: near.linkedTo === conduit, near2: near2.linkedTo === conduit, far: far.linkedTo };
  });
  expect(linked).toEqual({ links: 2, near: true, near2: true, far: null });

  const shielded = await hitEach(page, ['near', 'far'], 10);
  expect(shielded.far).toBeCloseTo(10, 6);
  expect(shielded.near).toBeCloseTo(10 * (1 - CONDUIT_DR), 6);

  // render_game_to_text exposes the tether on both ends
  const snap = await snapshot(page);
  const grunts = snap.visibleEnemies.filter(e => e.type === 'GRUNT');
  expect(grunts.filter(e => e.linked)).toHaveLength(2);
  expect(grunts.filter(e => !e.linked)).toHaveLength(1);
  expect(snap.visibleEnemies.find(e => e.type === 'CONDUIT')).toMatchObject({ linked: false, links: 2 });

  // kill the source: the tether is gone at once, not on the next tick
  await page.evaluate(() => window.__neon_test.hitEnemy(window.__pack.conduit, 1e9));
  expect(await page.evaluate(() => {
    const { conduit, near, near2 } = window.__pack;
    return { dead: conduit.dead, links: conduit.links.length, near: near.linkedTo, near2: near2.linkedTo };
  })).toEqual({ dead: true, links: 0, near: null, near2: null });
  const restored = await hitEach(page, ['near', 'far'], 10);
  expect(restored.near).toBeCloseTo(10, 6);
  expect(restored.far).toBeCloseTo(10, 6);

  await advance(page, 500);
  const after = await snapshot(page);
  expect(after.visibleEnemies.some(e => e.linked)).toBe(false);
  expectValidPlayer(after);
});

test('stacked resistance stays under the cap; bosses and conduits are never tethered', async ({ page }) => {
  await startRun(page, { seed: 12 });
  await spawnPack(page, {
    armored: { type: 'grunt', dx: 250, dy: 90, elite: ARMORED },
    // tougher than anything in the game, purely to prove the cap clamps
    plated: { type: 'grunt', dx: 250, dy: -90, elite: { ...ARMORED, dr: 0.5 } },
    other: { type: 'conduit', dx: 330, dy: 60 },
    boss: { boss: 'sentinel', dx: 380, dy: -60 },
  });
  await page.evaluate(() => { for (const k of ['near', 'near2']) window.__pack[k].dead = true; });
  await advance(page, 400);

  const links = await page.evaluate(() => {
    const { conduit, other, boss, armored, plated } = window.__pack;
    return {
      armored: armored.linkedTo === conduit || armored.linkedTo === other,
      plated: plated.linkedTo === conduit || plated.linkedTo === other,
      boss: boss.linkedTo ?? null,
      conduit: conduit.linkedTo,
      other: other.linkedTo,
    };
  });
  expect(links).toEqual({ armored: true, plated: true, boss: null, conduit: null, other: null });

  const dealt = await hitEach(page, ['armored', 'plated'], 10);
  expect(dealt.armored).toBeCloseTo(10 * (1 - 0.26) * (1 - CONDUIT_DR), 6);
  expect(dealt.plated).toBeCloseTo(10 * (1 - DR_CAP), 6);
  for (const v of Object.values(dealt)) expect(v).toBeGreaterThanOrEqual(10 * (1 - DR_CAP) - 1e-9);

  // a few more retargets never pick up the boss or the other conduit either
  await advance(page, 3000);
  expect(await page.evaluate(() => {
    const { conduit, other, boss } = window.__pack;
    return [boss.linkedTo ?? null, conduit.linkedTo, other.linkedTo,
      [...conduit.links, ...other.links].some(o => o.boss || o.conduit)];
  })).toEqual([null, null, null, false]);
});

test('tethers drop when the ally dies, leaves range, the conduit is retired, or threats are purged', async ({ page }) => {
  await startRun(page, { seed: 13 });
  await spawnPack(page);
  await advance(page, 500);

  // the ally dies
  await page.evaluate(() => window.__neon_test.hitEnemy(window.__pack.near, 1e9));
  expect(await page.evaluate(() => {
    const { conduit, near } = window.__pack;
    return [conduit.links.includes(near), near.linkedTo];
  })).toEqual([false, null]);

  // the ally leaves range
  await page.evaluate(() => { window.__pack.near2.x += 700; });
  await advance(page, 20);
  expect(await page.evaluate(() => {
    const { conduit, near2 } = window.__pack;
    return [conduit.links.includes(near2), near2.linkedTo];
  })).toEqual([false, null]);

  // the conduit is retired without a kill (recycling and fuses just set `dead`)
  await page.evaluate(() => {
    const t = window.__neon_test;
    window.__pack.fresh = t.spawn('grunt', { pos: { x: window.__pack.conduit.x - 60, y: window.__pack.conduit.y }, hp: 1e6 });
  });
  await advance(page, 2000);
  expect(await page.evaluate(() => window.__pack.fresh.linkedTo === window.__pack.conduit)).toBe(true);
  await page.evaluate(() => { window.__pack.conduit.dead = true; });
  const hit = await hitEach(page, ['fresh'], 10);
  expect(hit.fresh).toBeCloseTo(10, 6);
  await advance(page, 20);
  expect(await page.evaluate(() => window.__pack.fresh.linkedTo)).toBeNull();

  // a purge clears everything, and play carries on cleanly
  await spawnPack(page);
  await advance(page, 500);
  expect((await snapshot(page)).visibleEnemies.some(e => e.linked)).toBe(true);
  await page.evaluate(() => window.__neon_test.clearThreats());
  const purged = await snapshot(page);
  expect(purged.counts.enemies).toBe(0);
  expect(await page.evaluate(() => window.__pack.conduit.dead)).toBe(true);
  await page.evaluate(() => window.__neon_test.setHealth(Infinity));
  await advance(page, 1000);
  expectValidPlayer(await snapshot(page));
});

test('the CONDUIT joins the roster at its unlock time and warns once per run', async ({ page }) => {
  // toasts run on wall-clock timers, so the tip can sit behind a few queued ones
  test.setTimeout(60_000);
  await startRun(page, { seed: 14 });
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => window.__toasts.push(document.getElementById('toast').textContent))
      .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
  });
  const conduits = () => page.evaluate(() => window.__neon_test.enemies().filter(e => e.type === 'conduit').length);
  const play = async seconds => {
    for (let i = 0; i < seconds; i++) {
      await survive(page, 1000);
      if ((await snapshot(page)).mode === 'levelup') await pickFirstCard(page);
      if (await conduits()) return true;
    }
    return false;
  };

  // just before the unlock: never
  await page.evaluate(() => window.__neon_test.setSpawnClock(215));
  expect(await play(20)).toBe(false);

  // after it: the director deals one in
  await page.evaluate(() => window.__neon_test.setSpawnClock(241));
  expect(await play(60)).toBe(true);
  await expect.poll(() => page.evaluate(t => window.__toasts.filter(x => x === t).length, TIP),
    { timeout: 20_000 }).toBe(1);

  // more conduits in the same run never repeat the warning
  await page.evaluate(() => {
    const t = window.__neon_test, p = t.player();
    t.spawn('conduit', { pos: { x: p.x + 200, y: p.y } });
    t.spawn('conduit', { pos: { x: p.x - 200, y: p.y } });
  });
  await page.waitForTimeout(3500);
  expect(await page.evaluate(t => window.__toasts.filter(x => x === t).length, TIP)).toBe(1);
});

test('the same seed replays a CONDUIT encounter identically', async ({ page }) => {
  const encounter = async () => {
    await startRun(page, { seed: 2024 });
    await page.evaluate(() => {
      const t = window.__neon_test, p = t.player();
      t.setSpawnClock(245);
      t.spawn('conduit', { pos: { x: p.x + 320, y: p.y } });
      for (const dy of [-60, 0, 60]) t.spawn('grunt', { pos: { x: p.x + 230, y: p.y + dy } });
    });
    const snaps = [];
    for (let i = 0; i < 12; i++) {
      await survive(page, 1000);
      const snap = await snapshot(page);
      snaps.push(snap);
      if (snap.mode === 'levelup') await pickFirstCard(page);
      else expect(snap.mode).toBe('playing');
    }
    return snaps;
  };

  const first = await encounter();
  expect(first.some(s => s.visibleEnemies.some(e => e.linked))).toBe(true);
  expect(await encounter()).toEqual(first);
});
