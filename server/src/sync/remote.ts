import type { SyncRemoteResult, SyncRemoteRun, SyncRemoteStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { generateX25519 } from '../crypto/primitives.js';
import { sessionCookies, type SessionCookie } from '../ig/cookies.js';
import { uniform, type Rng } from '../ig/humaninput.js';
import type { TabLook } from '../ig/loginwatch.js';
import { HEADER, openFromHome, parsePairingCode, signRequest, type Pairing } from './protocol.js';
import type { SealedState } from './store.js';

/*
 * The receiving side of session sync: when Instagram is logged out here (the login watch's polls), asks the paired home
 * insta_logger for a separate session (sync/home.ts), opens the sealed answer and puts the cookies into the browser
 * like a pasted session. The home address is the owner's choice (e.g. a relay into a VPN to the home network); the
 * answer is sealed end to end, so plain HTTP on that path reveals nothing, but HTTPS is verified when used. Redirects
 * are not followed and answers are size-capped.
 *
 * Restraint: settles 15–30 s after the login page shows, at most one fetch per logout episode at a time, a cooldown
 * after every outcome (the home's own retry hint when it gives one), a pause after MAX_FAILURES failures in a row,
 * nothing after the owner logged Instagram out on purpose, nor while the owner uses the Instagram screen.
 */

const CONFIG_KEY = 'sync_remote';
const STATUS_KEY = 'sync_remote_status';
export const MAX_FAILURES = 3;
const COOLDOWN_MS = 15 * 60_000;
const OWNER_QUIET_MS = 2 * 60_000;
/** The home's separate login takes about a minute; give up after this. */
const FETCH_DEADLINE_MS = 5 * 60_000;
const ANSWER_MAX = 64 * 1024;
export const URL_MAX = 300;

interface Config {
  url: string;
  code: string;
  enabled: boolean;
}

interface Persisted {
  lastAttemptAt: number | null;
  lastResult: SyncRemoteResult | null;
  failures: number;
  /** No automatic fetch before this (cooldown / the home's retry hint). */
  notBefore: number | null;
}

const EMPTY: Persisted = { lastAttemptAt: null, lastResult: null, failures: 0, notBefore: null };

export interface SyncRemoteDeps {
  importSession: (cookies: SessionCookie[]) => Promise<void>;
  fetch?: typeof fetch;
  rng?: Rng;
  sleep?: (ms: number) => Promise<void>;
}

/** Normalizes the home address: http(s), host (and port), optional path prefix; no credentials, query or fragment. */
export function normalizeHomeUrl(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || !u.hostname) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export class SyncRemote {
  private persisted: Persisted;
  private running = false;
  private suppressed = false;
  private loginSince: number | null = null;
  private settleMs = 0;
  private readonly rng: Rng;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly ctx: AppContext,
    private readonly store: SealedState,
    private readonly deps: SyncRemoteDeps,
  ) {
    this.persisted = store.getPlain(STATUS_KEY, EMPTY);
    this.rng = deps.rng ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.fetchFn = deps.fetch ?? fetch;
  }

  private config(): (Config & { pairing: Pairing }) | null {
    const c = this.store.get<Config>(CONFIG_KEY);
    const pairing = c ? parsePairingCode(c.code) : null;
    return c && pairing ? { ...c, pairing } : null;
  }

  status(): SyncRemoteStatus {
    const c = this.config();
    return {
      configured: !!c,
      url: c?.url ?? null,
      enabled: !!c?.enabled,
      paused: this.persisted.failures >= MAX_FAILURES,
      running: this.running,
      lastAttemptAt: this.persisted.lastAttemptAt,
      lastResult: this.persisted.lastResult,
    };
  }

  /** Saves the home address + pairing code (both given) and/or switches automatic fetching on or off. */
  save(input: { url?: string; code?: string; enabled?: boolean }): void {
    const cur = this.store.get<Config>(CONFIG_KEY);
    let next: Config | null = cur;
    if (input.url !== undefined || input.code !== undefined) {
      const url = input.url === undefined ? null : normalizeHomeUrl(input.url);
      const code = input.code?.trim();
      if (!url || !code || !parsePairingCode(code)) throw new Error('url and code together');
      next = { url, code, enabled: input.enabled ?? cur?.enabled ?? true };
      this.persisted = { ...EMPTY };
      this.saveStatus();
    }
    if (!next) throw new Error('nothing saved yet');
    if (input.enabled !== undefined) next = { ...next, enabled: input.enabled };
    this.store.set(CONFIG_KEY, next);
  }

  remove(): void {
    this.store.delete(CONFIG_KEY);
    this.persisted = { ...EMPTY };
    this.saveStatus();
  }

  private saveStatus(): void {
    this.store.setPlain(STATUS_KEY, this.persisted);
  }

  /* ------------------------------------------------ the login watch */

  suppress(): void {
    this.suppressed = true;
  }

  onLoggedIn(): void {
    this.suppressed = false;
    this.loginSince = null;
  }

  /** The status line while logged out, when sync has something to say. */
  note(): string | null {
    if (this.running) return 'Getting a session from the home insta_logger…';
    const c = this.config();
    if (!c?.enabled) return null;
    if (this.persisted.failures >= MAX_FAILURES) return 'Session sync paused after failed attempts: see the Instagram page';
    return null;
  }

  /** Called on every poll of the login watch while logged out. */
  consider(look: TabLook, now = Date.now()): void {
    if (look.kind !== 'login') {
      if (look.kind !== 'challenge') this.loginSince = null;
      return;
    }
    if (this.loginSince === null) {
      this.loginSince = now;
      this.settleMs = uniform(this.rng, 15_000, 30_000);
    }
    const c = this.config();
    if (!c?.enabled || this.running || this.suppressed || this.persisted.failures >= MAX_FAILURES) return;
    if (now - this.loginSince < this.settleMs) return;
    if (now - this.ctx.ownerInputAt < OWNER_QUIET_MS) return;
    if (this.persisted.notBefore !== null && now < this.persisted.notBefore) return;
    void this.run(c);
  }

  /** "Get session now": ignores the pause, the cooldown and an earlier manual logout. */
  runNow(look: TabLook): SyncRemoteRun['result'] {
    const c = this.config();
    if (!c) return 'not_configured';
    if (look.kind !== 'login' && look.kind !== 'challenge') return 'not_on_login_page';
    if (this.running) return 'busy';
    this.suppressed = false;
    this.persisted.failures = 0;
    void this.run(c);
    return 'started';
  }

  /** One fetch: ask, wait for the home's separate login, open the answer, import it. */
  async run(c: Config & { pairing: Pairing }): Promise<SyncRemoteResult> {
    if (this.running) return 'error';
    this.running = true;
    const now = Date.now();
    this.persisted.lastAttemptAt = now;
    this.saveStatus();
    this.ctx.repo.audit('sync_fetch_attempt', null);
    let result: SyncRemoteResult = 'error';
    let retryMs: number | undefined;
    try {
      const mine = generateX25519();
      const deadline = now + FETCH_DEADLINE_MS;
      for (;;) {
        const r = await this.ask(c, mine.publicRaw);
        if (r.kind === 'done') {
          let cookies: SessionCookie[];
          try {
            const body = JSON.parse(openFromHome(c.pairing, mine, r.box).toString('utf8')) as { v?: unknown; cookies?: unknown };
            if (body.v !== 1 || !Array.isArray(body.cookies)) throw new Error('shape');
            const pairs = (body.cookies as { name?: unknown; value?: unknown }[])
              .filter((x) => typeof x?.name === 'string' && typeof x?.value === 'string')
              .map((x) => [x.name, x.value] as [string, string]);
            cookies = sessionCookies(pairs);
          } catch {
            result = 'refused';
            break;
          }
          try {
            await this.deps.importSession(cookies);
            result = 'logged_in';
          } catch {
            result = 'not_taken';
          }
          break;
        }
        if (r.kind === 'working') {
          if (Date.now() + r.retryMs > deadline) {
            result = 'home_busy';
            break;
          }
          await this.sleep(r.retryMs);
          continue;
        }
        result = r.result;
        retryMs = r.retryMs;
        break;
      }
    } catch {
      result = 'error';
    } finally {
      this.running = false;
    }
    this.persisted.lastResult = result;
    if (result === 'logged_in') this.persisted.failures = 0;
    else if (result !== 'home_busy' && result !== 'home_cooldown') this.persisted.failures++;
    this.persisted.notBefore = Date.now() + Math.max(COOLDOWN_MS, retryMs ?? 0);
    this.saveStatus();
    this.ctx.repo.audit('sync_fetch_result', null, result);
    this.ctx.log.info({ result }, 'session sync: session from the home');
    return result;
  }

  private async ask(
    c: Config & { pairing: Pairing },
    pub: Buffer,
  ): Promise<{ kind: 'done'; box: string } | { kind: 'working'; retryMs: number } | { kind: 'error'; result: SyncRemoteResult; retryMs?: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${c.url}/api/sync/session`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          [HEADER]: signRequest(c.pairing, pub),
          // Routing hint for the home's gateway (which user); the signature is what authenticates.
          cookie: `igl_tenant=${c.pairing.tenant}; __Host-igl_tenant=${c.pairing.tenant}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: 'error', result: 'unreachable' };
    }
    const text = await readCapped(res);
    interface Answer {
      state?: unknown;
      box?: unknown;
      retryMs?: unknown;
      error?: { code?: unknown };
    }
    let body: Answer | null = null;
    try {
      const v: unknown = text === null ? null : JSON.parse(text);
      body = v && typeof v === 'object' ? (v as Answer) : null;
    } catch {
      body = null;
    }
    if (res.status === 200 && body?.state === 'done' && typeof body.box === 'string') return { kind: 'done', box: body.box };
    if (res.status === 202 && body?.state === 'working') {
      const ms = typeof body.retryMs === 'number' ? Math.min(Math.max(body.retryMs, 2000), 30_000) : 5000;
      return { kind: 'working', retryMs: ms };
    }
    const code = typeof body?.error?.code === 'string' ? body.error.code : '';
    const retryMs = typeof body?.retryMs === 'number' && body.retryMs > 0 ? Math.min(body.retryMs, 24 * 3600_000) : undefined;
    const map: Record<string, SyncRemoteResult> = {
      sync_busy: 'home_busy',
      sync_cooldown: 'home_cooldown',
      sync_paused: 'home_paused',
      sync_no_password: 'home_no_password',
      sync_challenge: 'home_challenge',
      sync_failed: 'home_failed',
      sync_no_form: 'home_failed',
      sync_covered: 'home_busy',
      sync_error: 'home_failed',
      unauthorized: 'refused',
    };
    if (map[code]) return { kind: 'error', result: map[code], retryMs };
    if (res.status === 401 || res.status === 403) return { kind: 'error', result: 'refused' };
    if (res.status === 429) return { kind: 'error', result: 'home_cooldown', retryMs };
    return { kind: 'error', result: 'unreachable' };
  }
}

async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANSWER_MAX) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
