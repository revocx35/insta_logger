import { describe, expect, it } from 'vitest';
import { KEY, clickPoint, duration, keysymOf, loginPlan, mousePath, needsShift, neighbourKey, seeded, typeText, type Step } from './humaninput.js';

/**
 * Replays key steps the way X would and returns the typed text: Backspace erases, keys pressed with Control held are
 * shortcuts (Ctrl+A), Tab and Enter aren't text. Also checks that Shift is held for exactly the characters that need it
 * and that no key is left down.
 */
function replay(steps: Step[]): string {
  let out = '';
  let shift = false;
  let ctrl = false;
  const down = new Set<number>();
  for (const s of steps) {
    if (s.kind !== 'key') continue;
    if (s.keysym === KEY.shift) shift = s.down;
    else if (s.keysym === KEY.control) ctrl = s.down;
    if (!s.down) {
      down.delete(s.keysym);
      continue;
    }
    expect(down.has(s.keysym)).toBe(false); // a key never goes down twice without coming up
    down.add(s.keysym);
    if ([KEY.shift, KEY.control, KEY.tab, KEY.enter].includes(s.keysym as never) || ctrl) continue;
    if (s.keysym === KEY.backspace) {
      out = out.slice(0, -1);
      continue;
    }
    const ch = s.keysym >= 0x01000000 ? String.fromCodePoint(s.keysym - 0x01000000) : String.fromCharCode(s.keysym);
    expect(shift).toBe(needsShift(ch));
    out += ch;
  }
  expect(down.size).toBe(0);
  expect(shift).toBe(false);
  return out;
}

describe('keyboard', () => {
  it('maps characters to keysyms and knows which need Shift', () => {
    expect(keysymOf('a')).toBe(0x61);
    expect(keysymOf('ü')).toBe(0xfc);
    expect(keysymOf('ş')).toBe(0x0100015f);
    expect(needsShift('A')).toBe(true);
    expect(needsShift('@')).toBe(true);
    expect(needsShift('a')).toBe(false);
    expect(needsShift('.')).toBe(false);
  });

  it('slips only to a neighbouring key', () => {
    const rng = seeded(1);
    for (let i = 0; i < 50; i++) expect(['w', 'r']).toContain(neighbourKey('e', rng));
    expect(neighbourKey('Q', rng)).toBe('W');
    expect(neighbourKey('5', rng)).toBeNull();
  });

  it('types the exact text across many random plans, typos included', () => {
    const texts = ['owner.account', 'Pa55word!@#', 'MiXeD_Case-1/2?', 'şifreÜç', 'aa  bb'];
    for (let seed = 1; seed <= 200; seed++) {
      for (const t of texts) {
        const steps = typeText(t, seeded(seed), { typoRate: 0.2, maxTypos: 3 });
        expect(replay(steps)).toBe(t);
      }
    }
  });

  it('makes typos sometimes and erases them', () => {
    let typos = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const steps = typeText('abcdefghij', seeded(seed), { typoRate: 0.1, maxTypos: 2 });
      typos += steps.filter((s) => s.kind === 'key' && s.keysym === KEY.backspace && s.down).length;
    }
    expect(typos).toBeGreaterThan(20);
  });

  it('has human, irregular rhythm', () => {
    const steps = typeText('a'.repeat(1) + 'bcdefghijklmnopqrstuvwxyz', seeded(7), { typoRate: 0 });
    const downs: number[] = [];
    let t = 0;
    for (const s of steps) {
      t += s.wait;
      if (s.kind === 'key' && s.down) downs.push(t);
    }
    const gaps = downs.slice(1).map((d, i) => d - downs[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    expect(mean).toBeGreaterThan(80);
    expect(mean).toBeLessThan(400);
    expect(sd / mean).toBeGreaterThan(0.15); // not a metronome
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  });
});

describe('mouse', () => {
  it('ends exactly on the target, moves in small steps and curves', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = seeded(seed);
      const path = mousePath({ x: 100, y: 700 }, { x: 640, y: 300 }, 260, rng);
      const moves = path.filter((s): s is Extract<Step, { kind: 'move' }> => s.kind === 'move');
      expect(moves.at(-1)).toMatchObject({ x: 640, y: 300 });
      expect(moves.length).toBeGreaterThan(15);
      for (const m of moves) expect(m.wait).toBeLessThan(200);
      const ms = duration(path);
      expect(ms).toBeGreaterThan(200);
      expect(ms).toBeLessThan(2500);
    }
  });

  it('is not a straight line', () => {
    let offLine = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const path = mousePath({ x: 0, y: 0 }, { x: 600, y: 0 }, 200, seeded(seed));
      const maxDev = Math.max(...path.map((s) => (s.kind === 'move' ? Math.abs(s.y) : 0)));
      if (maxDev > 4) offLine++;
    }
    expect(offLine).toBeGreaterThan(20);
  });

  it('clicks inside the field, away from its edges', () => {
    const rng = seeded(3);
    for (let i = 0; i < 200; i++) {
      const p = clickPoint({ x: 100, y: 200, width: 260, height: 38 }, rng);
      expect(p.x).toBeGreaterThan(100 + 260 * 0.1);
      expect(p.x).toBeLessThan(100 + 260 * 0.9);
      expect(p.y).toBeGreaterThan(200 + 38 * 0.25);
      expect(p.y).toBeLessThan(200 + 38 * 0.75);
    }
  });
});

describe('loginPlan', () => {
  const layout = {
    screen: { width: 1280, height: 800 },
    username: { x: 500, y: 250, width: 268, height: 38 },
    password: { x: 500, y: 296, width: 268, height: 38 },
    submit: { x: 500, y: 350, width: 268, height: 32 },
  };

  it('clicks the username field, types both, submits — and the typed text is right', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      const steps = loginPlan(layout, 'owner.account', 'S3cret!pw', seeded(seed));
      const firstDown = steps.find((s) => s.kind === 'button' && s.down) as Extract<Step, { kind: 'button' }>;
      expect(firstDown.x).toBeGreaterThanOrEqual(500);
      expect(firstDown.x).toBeLessThanOrEqual(768);
      expect(firstDown.y).toBeGreaterThanOrEqual(250);
      expect(firstDown.y).toBeLessThanOrEqual(288);
      // Both texts come out right (Ctrl+A in between is a selection, not text).
      const text = replay(steps);
      expect(text).toBe('owner.accountS3cret!pw');
      const submitted = steps.some((s) => s.kind === 'key' && s.keysym === KEY.enter) ? 'enter' : 'click';
      const viaTab = steps.some((s) => s.kind === 'key' && s.keysym === KEY.tab) ? 'tab' : 'mouse';
      seen.add(`${submitted}/${viaTab}`);
      const total = duration(steps);
      expect(total).toBeGreaterThan(3000);
      expect(total).toBeLessThan(20000);
    }
    // Different runs do it differently.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('only types the password when there is no username field', () => {
    const steps = loginPlan({ ...layout, username: null }, 'ignored', 'pw', seeded(9));
    expect(steps.filter((s) => s.kind === 'key' && s.keysym === 0x69 && s.down)).toHaveLength(0); // no "i" of "ignored"
    expect(steps.some((s) => s.kind === 'key' && s.keysym === KEY.tab)).toBe(false);
  });
});
