/*
 * Human-like input for the automatic Instagram login (ig/autologin.ts): mouse paths and typing rhythm, planned as a
 * timeline of pointer and key events and played through VNC (vnc/rfb.ts). Pure planning functions with an injectable
 * random source, so tests can check the shape of the result.
 *
 * Mouse: a curved (cubic Bézier) path with a minimum-jerk speed profile (slow start, fast middle, slow end), a
 * duration that follows Fitts's law, small tremor, ~60–125 Hz event spacing and, on long moves, sometimes an overshoot
 * with a correction. Clicks land off-centre and hold the button for a human time.
 * Keyboard: log-normal gaps between keys, key holds that overlap the next key now and then, Shift pressed for capitals
 * and symbols, short "thinking" pauses, and the occasional typo next to the intended key, noticed and erased.
 */

export type Rng = () => number;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Step =
  | { wait: number; kind: 'move'; x: number; y: number }
  | { wait: number; kind: 'button'; x: number; y: number; down: boolean }
  | { wait: number; kind: 'key'; keysym: number; down: boolean };

export const KEY = {
  tab: 0xff09,
  escape: 0xff1b,
  enter: 0xff0d,
  backspace: 0xff08,
  shift: 0xffe1,
  control: 0xffe3,
  a: 0x61,
} as const;

/* ------------------------------------------------------------ random */

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function gaussian(rng: Rng, mean = 0, sd = 1): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-normal around [median] (sigma in log space): most values near the median, a long tail of slow ones. */
export function logNormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(gaussian(rng, 0, sigma));
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A seeded random source (mulberry32) for tests and reproducible plans. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- mouse */

/** Where a person clicks in a field or button: left of centre for text fields, never on the border. */
export function clickPoint(rect: Rect, rng: Rng, textField = true): Point {
  const fx = clamp(gaussian(rng, textField ? 0.38 : 0.5, 0.13), 0.12, 0.88);
  const fy = clamp(gaussian(rng, 0.5, 0.12), 0.28, 0.72);
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

/** Movement time by Fitts's law (ms), with some person-to-person spread. */
export function fittsMs(distance: number, targetWidth: number, rng: Rng): number {
  const id = Math.log2(distance / Math.max(targetWidth, 8) + 1);
  return (110 + 150 * id) * uniform(rng, 0.85, 1.3);
}

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** One movement segment: curved path, minimum-jerk timing, tremor, ~8–16 ms between events. */
function segment(from: Point, to: Point, targetWidth: number, rng: Rng): Step[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [];
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend1 = gaussian(rng, 0, Math.min(dist * 0.18, 120));
  const bend2 = gaussian(rng, 0, Math.min(dist * 0.1, 60));
  const s1 = uniform(rng, 0.2, 0.4);
  const s2 = uniform(rng, 0.6, 0.85);
  const c1 = { x: from.x + dx * s1 + nx * bend1, y: from.y + dy * s1 + ny * bend1 };
  const c2 = { x: from.x + dx * s2 + nx * bend2, y: from.y + dy * s2 + ny * bend2 };
  const total = fittsMs(dist, targetWidth, rng);
  const steps: Step[] = [];
  let elapsed = 0;
  let last = { x: Math.round(from.x), y: Math.round(from.y) };
  while (elapsed < total) {
    const dt = uniform(rng, 8, 16);
    elapsed = Math.min(total, elapsed + dt);
    const tau = elapsed / total;
    const s = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5; // minimum-jerk progress
    const p = bezier(from, c1, c2, to, s);
    const tremor = tau < 1 ? 0.6 : 0;
    const q = { x: Math.round(p.x + gaussian(rng, 0, tremor)), y: Math.round(p.y + gaussian(rng, 0, tremor)) };
    if (q.x === last.x && q.y === last.y && tau < 1) continue;
    steps.push({ wait: dt, kind: 'move', x: q.x, y: q.y });
    last = q;
  }
  const end = steps[steps.length - 1];
  if (end && end.kind === 'move') {
    end.x = Math.round(to.x);
    end.y = Math.round(to.y);
  }
  return steps;
}

/** A human mouse movement from [from] to [to] (a target [targetWidth] wide): sometimes overshoots and corrects. */
export function mousePath(from: Point, to: Point, targetWidth: number, rng: Rng): Step[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 180 && rng() < 0.3) {
    const k = uniform(rng, 0.03, 0.08);
    const over = {
      x: to.x + (to.x - from.x) * k + gaussian(rng, 0, 3),
      y: to.y + (to.y - from.y) * k + gaussian(rng, 0, 3),
    };
    const first = segment(from, over, targetWidth, rng);
    const pause = uniform(rng, 40, 140);
    const back = segment(over, to, targetWidth, rng);
    if (back[0]) back[0].wait += pause;
    return [...first, ...back];
  }
  return segment(from, to, targetWidth, rng);
}

/** Press and release the left button at [p] after a short settle. */
export function click(p: Point, rng: Rng): Step[] {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  return [
    { wait: clamp(gaussian(rng, 110, 40), 45, 260), kind: 'button', x, y, down: true },
    { wait: clamp(gaussian(rng, 95, 25), 50, 170), kind: 'button', x, y, down: false },
  ];
}

/* ---------------------------------------------------------- keyboard */

const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');

/** Whether a US-layout keyboard needs Shift for [ch]. */
export function needsShift(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || SHIFTED.has(ch);
}

/** The X keysym of a character: Latin-1 maps directly, everything else to the Unicode keysym range. */
export function keysymOf(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** A key next to [ch] on a QWERTY keyboard (same row), or null when there is none to slip to. */
export function neighbourKey(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase();
  for (const row of ROWS) {
    const i = row.indexOf(lower);
    if (i < 0) continue;
    const options = [row[i - 1], row[i + 1]].filter((c): c is string => !!c);
    const pick = options[Math.floor(rng() * options.length)]!;
    return ch === lower ? pick : pick.toUpperCase();
  }
  return null;
}

export interface TypingOptions {
  /** Median gap between keystrokes (ms). */
  medianGap?: number;
  /** Chance per character of hitting a neighbouring key first (then erasing it). */
  typoRate?: number;
  /** At most this many typos in this text. */
  maxTypos?: number;
}

interface KeyEv {
  at: number;
  keysym: number;
  down: boolean;
  seq: number;
}

/** Keystrokes for [text] as a person types it (absolute plan converted into waits). */
export function typeText(text: string, rng: Rng, opts: TypingOptions = {}): Step[] {
  const medianGap = opts.medianGap ?? 150;
  const typoRate = opts.typoRate ?? 0.02;
  let typosLeft = opts.maxTypos ?? 1;
  const evs: KeyEv[] = [];
  let seq = 0;
  let t = 0;
  let lastUp = 0;
  let shiftDown = false;
  let shiftUpAt = 0;
  let prevKey = 0;
  let prevKeyUp = 0;
  const push = (at: number, keysym: number, down: boolean) => evs.push({ at, keysym, down, seq: seq++ });

  const stroke = (keysym: number, shift: boolean, gap: number) => {
    let at = t + gap;
    if (shift && !shiftDown) {
      // Shift goes down first; the key follows after a short reach.
      const sAt = Math.max(at, lastUp + 15);
      push(sAt, KEY.shift, true);
      shiftDown = true;
      at = sAt + uniform(rng, 40, 110);
    } else if (!shift && shiftDown) {
      // Release Shift before an unshifted key (after the last shifted key is up).
      const sUp = Math.max(shiftUpAt, lastUp + uniform(rng, 10, 60));
      push(sUp, KEY.shift, false);
      shiftDown = false;
      at = Math.max(at, sUp + uniform(rng, 15, 50));
    }
    // The same key twice can't overlap itself.
    if (keysym === prevKey) at = Math.max(at, prevKeyUp + uniform(rng, 15, 40));
    const hold = clamp(gaussian(rng, 85, 22), 40, 170);
    prevKey = keysym;
    prevKeyUp = at + hold;
    push(at, keysym, true);
    push(at + hold, keysym, false);
    if (shiftDown) shiftUpAt = at + hold + uniform(rng, 10, 70);
    lastUp = Math.max(lastUp, at + hold);
    t = at;
  };

  const gap = () => clamp(logNormal(rng, medianGap, 0.38), 45, 900);

  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    let g = gap();
    if (i > 1 && rng() < 0.05) g += uniform(rng, 250, 900); // a moment of thought
    const slip = typosLeft > 0 && i > 1 && rng() < typoRate ? neighbourKey(ch, rng) : null;
    if (slip) {
      typosLeft--;
      stroke(keysymOf(slip), needsShift(slip), g);
      // Typing on for a moment is rare; noticing and erasing is the usual.
      const noticed = uniform(rng, 180, 550);
      stroke(KEY.backspace, false, noticed);
      g = uniform(rng, 120, 300);
    }
    stroke(keysymOf(ch), needsShift(ch), g);
  }
  if (shiftDown) push(Math.max(shiftUpAt, lastUp + 10), KEY.shift, false);
  return toSteps(evs);
}

function toSteps(evs: KeyEv[]): Step[] {
  evs.sort((a, b) => a.at - b.at || a.seq - b.seq);
  let prev = 0;
  return evs.map((e) => {
    const wait = Math.max(0, e.at - prev);
    prev = Math.max(prev, e.at);
    return { wait, kind: 'key', keysym: e.keysym, down: e.down };
  });
}

/** One key press (Tab, Enter …) after [before] ms. */
export function pressKey(keysym: number, rng: Rng, before = 0): Step[] {
  return [
    { wait: before, kind: 'key', keysym, down: true },
    { wait: clamp(gaussian(rng, 90, 25), 45, 170), kind: 'key', keysym, down: false },
  ];
}

/** Ctrl+A: selects whatever the field already holds, so typing replaces it. */
export function selectAll(rng: Rng): Step[] {
  return [
    { wait: uniform(rng, 120, 350), kind: 'key', keysym: KEY.control, down: true },
    { wait: uniform(rng, 50, 130), kind: 'key', keysym: KEY.a, down: true },
    { wait: uniform(rng, 50, 110), kind: 'key', keysym: KEY.a, down: false },
    { wait: uniform(rng, 20, 90), kind: 'key', keysym: KEY.control, down: false },
  ];
}

/** Total duration of a plan (ms). */
export function duration(steps: Step[]): number {
  return steps.reduce((s, x) => s + x.wait, 0);
}

/* -------------------------------------------------------- login plan */

export interface LoginLayout {
  screen: { width: number; height: number };
  username: Rect | null;
  password: Rect;
  submit: Rect | null;
}

/** One click on [target] (a button), the mouse drifting in from somewhere on the screen. */
export function clickPlan(screen: { width: number; height: number }, target: Rect, rng: Rng): Step[] {
  const at: Point = { x: uniform(rng, screen.width * 0.25, screen.width * 0.85), y: uniform(rng, screen.height * 0.45, screen.height * 0.9) };
  const p = clickPoint(target, rng, false);
  return [{ wait: 0, kind: 'move', x: Math.round(at.x), y: Math.round(at.y) }, ...mousePath(at, p, target.width, rng), ...click(p, rng)];
}

/**
 * The whole login as a person does it: drift in from somewhere on the screen, click the username field, type, go to
 * the password (mouse or Tab), type, then press Enter or click the button.
 */
export function loginPlan(layout: LoginLayout, username: string, password: string, rng: Rng): Step[] {
  const { width, height } = layout.screen;
  let at: Point = { x: uniform(rng, width * 0.25, width * 0.85), y: uniform(rng, height * 0.45, height * 0.9) };
  const steps: Step[] = [{ wait: 0, kind: 'move', x: Math.round(at.x), y: Math.round(at.y) }];
  const goClick = (rect: Rect, textField: boolean) => {
    const p = clickPoint(rect, rng, textField);
    steps.push(...mousePath(at, p, rect.width, rng), ...click(p, rng));
    at = p;
  };
  const typing = { medianGap: uniform(rng, 120, 190) };
  if (layout.username) {
    goClick(layout.username, true);
    steps.push(...selectAll(rng), ...typeText(username, rng, { ...typing, typoRate: 0.03, maxTypos: 2 }));
    // Chromium's passkey suggestion ("Use passkey from another device") drops down from the focused username field over
    // the top of the password field: a click there opens the security-key dialog and the keys go astray (2026-11-02).
    // Escape closes it, as a person would before reaching for the password.
    steps.push(...pressKey(KEY.escape, rng, uniform(rng, 180, 520)));
  }
  if (layout.username && rng() < 0.3) {
    steps.push(...pressKey(KEY.tab, rng, uniform(rng, 250, 700)));
  } else {
    const think = uniform(rng, 200, 650);
    const before = steps.length;
    goClick(layout.password, true);
    if (steps[before]) steps[before]!.wait += think;
  }
  steps.push(...selectAll(rng), ...typeText(password, rng, { ...typing, typoRate: 0.015, maxTypos: 1 }));
  if (layout.submit && rng() < 0.45) {
    const before = steps.length;
    goClick(layout.submit, false);
    if (steps[before]) steps[before]!.wait += uniform(rng, 250, 900);
  } else {
    steps.push(...pressKey(KEY.enter, rng, uniform(rng, 300, 1000)));
  }
  return steps;
}
