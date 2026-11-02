import fs from 'node:fs';
import path from 'node:path';
import type { AutoLoginResult, AutoLoginStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { openGcm, randomKey, sealGcm } from '../crypto/primitives.js';
import { RfbInput } from '../vnc/rfb.js';
import type { ChromiumLink, CdpTarget } from './chromium.js';
import { clickPlan, loginPlan, uniform, type Rng, type Step } from './humaninput.js';
import { readLoginForm } from './loginform.js';
import type { TabInfo, TabLook } from './loginwatch.js';

/*
 * Automatic login with a saved Instagram password: when Instagram ends the session and the tab lands on its login page,
 * insta_logger types the saved username and password like a person would (ig/humaninput.ts) through the tenant's VNC
 * screen — the same input path as the owner's own viewer — and the normal login watch attaches once Instagram is in.
 *
 * Storage: the credentials are AES-256-GCM sealed in app_state under a random key in a separate file in the tenant's
 * data directory (0600, the worker's own unix user). The worker must read them with nobody logged in to insta_logger,
 * so they can't be under the owner's password like the logged data; a stolen database alone doesn't reveal them.
 * They are never logged, never returned by the API (only the username, which the owner typed and sees anyway).
 *
 * Restraint: one attempt per logout, at least COOLDOWN_MS apart, a pause after MAX_FAILURES failed attempts in a row
 * (until the owner saves again or presses "Log in now"), never while the owner is using the VNC screen (their input stops a running attempt), never after the
 * owner logged Instagram out on purpose, and never on a check/2FA page (those stay with the owner).
 */

const STATE_KEY = 'ig_autologin';
const STATUS_KEY = 'ig_autologin_status';
const AAD = 'igl/v1|app_state|ig_autologin';
const COOLDOWN_MS = 10 * 60_000;
/** Form not found / covered: look again sooner (the page may still be loading). */
const SOFT_COOLDOWN_MS = 2 * 60_000;
export const MAX_FAILURES = 2;
/** After a click on the profile picker, how many times to look for the login form. */
const PICKER_LOOKS = 4;
/** The owner used the VNC screen this recently: leave the login to them. */
export const OWNER_QUIET_MS = 2 * 60_000;
/** After submitting, how long Instagram gets to log in before the attempt counts as failed. */
const VERDICT_MS = 60_000;
export const USERNAME_MAX = 100;
export const PASSWORD_MAX_IG = 256;

interface Stored {
  v: 1;
  enabled: boolean;
  /** Not secret, shown back to the owner. Kept inside the sealed blob too. */
  sealed: string;
}

interface Persisted {
  lastAttemptAt: number | null;
  lastResult: AutoLoginResult | null;
  failures: number;
}

export interface Policy {
  saved: boolean;
  enabled: boolean;
  suppressed: boolean;
  failures: number;
  lastAttemptAt: number | null;
  lastSoft: boolean;
  /** When the tab was first seen on the login page in this logout. */
  loginSince: number | null;
  settleMs: number;
  /** When the owner last used the VNC screen. */
  ownerInputAt: number;
  now: number;
}

/** Whether an automatic attempt may start now (pure; see the restraint rules above). */
export function mayAttempt(p: Policy): boolean {
  if (!p.saved || !p.enabled || p.suppressed || p.failures >= MAX_FAILURES) return false;
  if (p.now - p.ownerInputAt < OWNER_QUIET_MS) return false;
  if (p.loginSince === null || p.now - p.loginSince < p.settleMs) return false;
  if (p.lastAttemptAt !== null && p.now - p.lastAttemptAt < (p.lastSoft ? SOFT_COOLDOWN_MS : COOLDOWN_MS)) return false;
  return true;
}

/** Validates a username/password pair from the API (no control characters; the caps keep typing time sane). */
export function validCredentials(username: string, password: string): boolean {
  // eslint-disable-next-line no-control-regex
  const ctl = /[\u0000-\u001f\u007f]/;
  return (
    username.trim().length > 0 &&
    username.length <= USERNAME_MAX &&
    password.length > 0 &&
    password.length <= PASSWORD_MAX_IG &&
    !ctl.test(username) &&
    !ctl.test(password)
  );
}

export interface AutoLoginDeps {
  chromium: Pick<ChromiumLink, 'vncPassword' | 'openVncTunnel'>;
  /** The status line should be refreshed from note(). */
  report: () => void;
  rng?: Rng;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readForm?: typeof readLoginForm;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class AutoLogin {
  private persisted: Persisted;
  private busy = false;
  private typing = false;
  private suppressed = false;
  private loginSince: number | null = null;
  private settleMs = 0;
  private lastSoft = false;
  private verdict: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private readonly rng: Rng;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly readForm: typeof readLoginForm;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: AutoLoginDeps,
  ) {
    this.rng = deps.rng ?? Math.random;
    this.sleep = deps.sleep ?? abortableSleep;
    this.readForm = deps.readForm ?? readLoginForm;
    this.persisted = this.loadStatus();
  }

  /* ------------------------------------------------------ storage */

  private get keyPath(): string {
    return path.join(this.ctx.config.dataDir, 'autologin.key');
  }

  private key(create: boolean): Buffer | null {
    try {
      const k = fs.readFileSync(this.keyPath);
      if (k.length === 32) return k;
    } catch {
      /* not there yet */
    }
    if (!create) return null;
    const k = randomKey();
    fs.writeFileSync(this.keyPath, k, { mode: 0o600 });
    return k;
  }

  private stored(): Stored | null {
    try {
      const raw = this.ctx.repo.getState(STATE_KEY);
      const s = raw ? (JSON.parse(raw) as Stored) : null;
      return s && s.v === 1 && typeof s.sealed === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  private credentials(): { username: string; password: string } | null {
    const s = this.stored();
    const key = this.key(false);
    if (!s || !key) return null;
    try {
      const v = JSON.parse(openGcm(key, Buffer.from(s.sealed, 'base64'), AAD).toString('utf8')) as { u?: unknown; p?: unknown };
      return typeof v.u === 'string' && typeof v.p === 'string' ? { username: v.u, password: v.p } : null;
    } catch {
      return null;
    }
  }

  /** Saves new credentials (both given) and/or switches the automatic login on or off. */
  save(input: { username?: string; password?: string; enabled?: boolean }): void {
    const cur = this.stored();
    let sealed = cur?.sealed;
    if (input.username !== undefined || input.password !== undefined) {
      if (input.username === undefined || input.password === undefined) throw new Error('username and password together');
      const body = Buffer.from(JSON.stringify({ u: input.username.trim(), p: input.password }), 'utf8');
      sealed = sealGcm(this.key(true)!, body, AAD).toString('base64');
      body.fill(0);
      this.persisted = { lastAttemptAt: null, lastResult: null, failures: 0 };
      this.saveStatus();
    }
    if (!sealed) throw new Error('nothing saved yet');
    const next: Stored = { v: 1, enabled: input.enabled ?? cur?.enabled ?? true, sealed };
    this.ctx.repo.setState(STATE_KEY, JSON.stringify(next));
  }

  remove(): void {
    this.cancel();
    this.ctx.repo.deleteState(STATE_KEY);
    this.ctx.repo.deleteState(STATUS_KEY);
    try {
      fs.rmSync(this.keyPath, { force: true });
    } catch {
      /* gone already */
    }
    this.persisted = { lastAttemptAt: null, lastResult: null, failures: 0 };
  }

  status(): AutoLoginStatus {
    const s = this.stored();
    const creds = s ? this.credentials() : null;
    return {
      saved: !!creds,
      username: creds?.username ?? null,
      enabled: !!s?.enabled,
      paused: this.persisted.failures >= MAX_FAILURES,
      running: this.busy || this.verdict !== null,
      lastAttemptAt: this.persisted.lastAttemptAt,
      lastResult: this.persisted.lastResult,
    };
  }

  /** The status line while logged out, when the automatic login has something to say. */
  note(): string | null {
    if (this.typing || this.verdict) return 'Logging in with the saved password…';
    const s = this.stored();
    if (!s?.enabled) return null;
    if (this.persisted.failures >= MAX_FAILURES) return 'Automatic login paused after failed attempts: log in on the Instagram screen';
    const thisLogout = this.loginSince !== null && (this.persisted.lastAttemptAt ?? 0) >= this.loginSince;
    if (thisLogout && this.persisted.lastResult === 'failed') return 'Automatic login did not work: log in on the Instagram screen';
    return null;
  }

  private loadStatus(): Persisted {
    try {
      const raw = this.ctx.repo.getState(STATUS_KEY);
      const v = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
      return { lastAttemptAt: v.lastAttemptAt ?? null, lastResult: v.lastResult ?? null, failures: v.failures ?? 0 };
    } catch {
      return { lastAttemptAt: null, lastResult: null, failures: 0 };
    }
  }

  private saveStatus(): void {
    this.ctx.repo.setState(STATUS_KEY, JSON.stringify(this.persisted));
  }

  private finish(result: AutoLoginResult): void {
    if (this.verdict) clearTimeout(this.verdict);
    this.verdict = null;
    this.persisted.lastResult = result;
    if (result === 'failed') this.persisted.failures++;
    if (result === 'logged_in') this.persisted.failures = 0;
    this.lastSoft = result === 'no_form' || result === 'covered' || result === 'busy';
    this.saveStatus();
    this.ctx.repo.audit('ig_autologin_result', null, result);
    this.ctx.log.info({ result }, 'automatic Instagram login');
  }

  /* ------------------------------------------------ the login watch */

  /** The owner logged Instagram out on purpose: no automatic login until Instagram is logged in again. */
  suppress(): void {
    this.suppressed = true;
    this.cancel();
  }

  /** Instagram is logged in (by us or by anyone): settle a pending attempt, reset the episode. */
  onLoggedIn(): void {
    if (this.verdict) this.finish('logged_in');
    this.suppressed = false;
    this.loginSince = null;
  }

  /** The tab moved to a check (captcha, 2FA, "was this you?"): that needs the owner. */
  onChallenge(): void {
    if (this.verdict) this.finish('challenge');
  }

  /** Stops typing (the tab changed hands, the service stops). */
  cancel(): void {
    this.abort?.abort();
  }

  /** Called on every poll of the login watch while the tab is on Instagram's login page. */
  consider(target: CdpTarget, look: TabLook, now = Date.now()): void {
    if (look.kind !== 'login' || !look.tab) {
      if (look.kind !== 'challenge') this.loginSince = null;
      return;
    }
    if (this.loginSince === null) {
      this.loginSince = now;
      this.settleMs = uniform(this.rng, 4_000, 12_000); // a person doesn't start typing the moment the page shows
    }
    if (this.busy || this.verdict) return;
    const s = this.stored();
    const ok = mayAttempt({
      saved: !!s,
      enabled: !!s?.enabled,
      suppressed: this.suppressed,
      failures: this.persisted.failures,
      lastAttemptAt: this.persisted.lastAttemptAt,
      lastSoft: this.lastSoft,
      loginSince: this.loginSince,
      settleMs: this.settleMs,
      ownerInputAt: this.ctx.ownerInputAt,
      now,
    });
    if (ok) void this.attempt(target, look);
  }

  /** "Log in now" from the UI: ignores the pause, the cooldown and an earlier manual logout. */
  async runNow(target: CdpTarget, look: TabLook): Promise<'started' | 'not_on_login_page' | 'not_saved' | 'busy'> {
    if (!this.credentials()) return 'not_saved';
    if (look.kind !== 'login' || !look.tab) return 'not_on_login_page';
    if (this.busy || this.verdict) return 'busy';
    this.suppressed = false;
    this.persisted.failures = 0;
    void this.attempt(target, look, true);
    return 'started';
  }

  /** [manual]: started by "Log in now" (the owner's recent screen use doesn't hold it back; new input still stops it). */
  private async attempt(target: CdpTarget, look: TabLook, manual = false): Promise<void> {
    const creds = this.credentials();
    if (!creds || !look.tab) return;
    this.busy = true;
    const abort = new AbortController();
    this.abort = abort;
    this.persisted.lastAttemptAt = Date.now();
    this.saveStatus();
    this.ctx.repo.audit('ig_autologin_attempt', null);
    try {
      const r = await this.fillForm(target, look.tab, creds, abort.signal, { manual, onTyping: () => this.deps.report() });
      if (r === 'typed' || r === 'maybe_in') this.awaitVerdict();
      else this.finish(r);
    } catch (err) {
      const aborted = abort.signal.aborted || (err as Error).message === 'aborted';
      this.finish(aborted ? 'busy' : 'error');
      if (!aborted) this.ctx.log.warn({ err: (err as Error).message }, 'automatic Instagram login failed');
    } finally {
      this.busy = false;
      this.typing = false;
      this.deps.report();
      if (this.abort === abort) this.abort = null;
    }
  }

  /**
   * Runs [fn] while holding the login lock (no automatic login meanwhile): the separate login for session sync
   * (ig/sidelogin.ts) uses the same screen and keyboard. Null when an attempt is already running.
   */
  async exclusive<T>(fn: (signal: AbortSignal, creds: { username: string; password: string }) => Promise<T>): Promise<T | 'busy' | 'not_saved'> {
    const creds = this.credentials();
    if (!creds) return 'not_saved';
    if (this.busy || this.verdict) return 'busy';
    this.busy = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      return await fn(abort.signal, creds);
    } finally {
      this.busy = false;
      this.typing = false;
      if (this.abort === abort) this.abort = null;
    }
  }

  /**
   * Fills the login form of [tab] with [creds] over VNC and submits it: reads the form (clicking through Instagram's
   * profile picker first), then plays the human input plan. 'typed': submitted; 'maybe_in': the picker's "Continue"
   * was clicked and no form followed (it may have logged in straight away). Throws 'aborted' when the owner's input
   * stopped it.
   */
  async fillForm(
    target: CdpTarget,
    tab: TabInfo,
    creds: { username: string; password: string },
    signal: AbortSignal,
    opts: { manual?: boolean; onTyping?: () => void } = {},
  ): Promise<'typed' | 'maybe_in' | 'no_form' | 'covered' | 'busy'> {
    let rfb: RfbInput | null = null;
    try {
      let form = await this.readForm(target, tab, creds.username);
      if (form.ok === false) return form.reason === 'covered' ? 'covered' : 'no_form';
      this.typing = true;
      opts.onTyping?.();
      // A short look at the page before reaching for the mouse.
      await this.sleep(uniform(this.rng, 600, 2200), signal);
      const started = Date.now();
      if (!opts.manual && this.ctx.ownerInputAt > started - OWNER_QUIET_MS) return 'busy';
      rfb = await RfbInput.connect(await this.deps.chromium.openVncTunnel(), await this.deps.chromium.vncPassword());
      if (form.ok === 'picker') {
        // Instagram's profile picker: "Continue" (the saved account) or "Use another profile", then the form.
        const own = form.own;
        await this.play(rfb, clickPlan(form.screen, form.button, this.rng), signal, started);
        for (let i = 0; i < PICKER_LOOKS; i++) {
          await this.sleep(uniform(this.rng, 1800, 3200), signal);
          form = await this.readForm(target, tab, creds.username);
          if (form.ok === true) break;
        }
        if (form.ok !== true) {
          // "Continue" may log straight in; otherwise the verdict counts it as failed.
          if (own) return 'maybe_in';
          return form.ok === false && form.reason === 'covered' ? 'covered' : 'no_form';
        }
        await this.sleep(uniform(this.rng, 400, 1400), signal);
      }
      const plan = loginPlan(form.layout, creds.username, creds.password, this.rng);
      await this.play(rfb, plan, signal, started);
      return 'typed';
    } catch (err) {
      if (signal.aborted) throw new Error('aborted');
      throw err;
    } finally {
      rfb?.close();
    }
  }

  /** Gives Instagram VERDICT_MS to log in (onLoggedIn settles it), else the attempt counts as failed. */
  private awaitVerdict(): void {
    this.verdict = setTimeout(() => {
      this.verdict = null;
      this.finish('failed');
      this.deps.report();
    }, VERDICT_MS);
    this.verdict.unref();
  }

  /** Plays a plan; the owner's own mouse or keyboard on the VNC screen meanwhile stops it (their hands win). */
  private async play(rfb: RfbInput, steps: Step[], signal: AbortSignal, started: number): Promise<void> {
    const pressed = new Set<number>();
    let buttonDown = false;
    let last = { x: 0, y: 0 };
    try {
      for (const s of steps) {
        if (s.wait > 0) await this.sleep(s.wait, signal);
        if (this.ctx.ownerInputAt > started) throw new Error('aborted');
        if (s.kind === 'move') {
          rfb.move(s.x, s.y);
          last = { x: s.x, y: s.y };
        } else if (s.kind === 'button') {
          rfb.button(s.x, s.y, s.down);
          buttonDown = s.down;
          last = { x: s.x, y: s.y };
        } else {
          rfb.key(s.keysym, s.down);
          if (s.down) pressed.add(s.keysym);
          else pressed.delete(s.keysym);
        }
      }
    } finally {
      // Never leave a key or the button held down.
      for (const k of pressed) rfb.key(k, false);
      if (buttonDown) rfb.button(last.x, last.y, false);
    }
  }
}
