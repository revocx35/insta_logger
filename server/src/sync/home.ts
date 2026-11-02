import type { SyncHomeResult, SyncHomeStatus, SyncSessionAnswer } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import type { SessionCookie } from '../ig/cookies.js';
import type { SideLoginResult } from '../ig/sidelogin.js';
import { newPairing, NonceCache, pairingCode, parseRequest, sealForRemote, verifyRequest } from './protocol.js';
import type { SealedState } from './store.js';

/*
 * The giving side of session sync: answers the paired remote's signed `GET /api/sync/session` by making a separate
 * Instagram login (ig/sidelogin.ts) and sealing its cookies for the remote (protocol.ts).
 *
 * Restraint (account safety, like the automatic login): one separate login at a time and never while the automatic
 * login runs (shared lock), at most one per MIN_GAP_MS, a pause of PAUSE_MS after MAX_FAILURES failed logins in a
 * row, nothing while the owner used the Instagram screen in the last 2 minutes, and a check page (2FA, "was this
 * you?") ends it — that stays with the owner.
 */

const PAIR_KEY = 'sync_home';
const DEVICE_KEY = 'sync_home_device';
const STATUS_KEY = 'sync_home_status';
export const MIN_GAP_MS = 15 * 60_000;
export const MAX_FAILURES = 3;
export const PAUSE_MS = 6 * 3600_000;
const OWNER_QUIET_MS = 2 * 60_000;
/** A finished job's answer waits this long for the remote to fetch it. */
const RESULT_TTL_MS = 5 * 60_000;
/** Bad signatures from anywhere: after this many in a window, every request is refused for the rest of it. */
const BAD_MAX = 20;
const BAD_WINDOW_MS = 15 * 60_000;

interface Pair {
  pairId: string;
  secret: string;
  createdAt: number;
}

interface Persisted {
  lastRequestAt: number | null;
  lastResult: SyncHomeResult | null;
  lastGivenAt: number | null;
  lastJobAt: number | null;
  failures: number;
  pausedUntil: number | null;
}

const EMPTY: Persisted = { lastRequestAt: null, lastResult: null, lastGivenAt: null, lastJobAt: null, failures: 0, pausedUntil: null };

interface Job {
  pub: string;
  state: 'working' | 'done' | 'failed';
  box?: string;
  reason?: SyncHomeResult;
  at: number;
}

export type HomeAnswer = { status: 200 | 202; body: SyncSessionAnswer } | { status: 401 | 409 | 429; code: string; message: string; retryMs?: number };

export interface SyncHomeDeps {
  /** Makes a separate login (the Instagram controller). */
  separateLogin: (device: SessionCookie[]) => Promise<SideLoginResult>;
  passwordSaved: () => boolean;
}

export class SyncHome {
  private persisted: Persisted;
  private job: Job | null = null;
  private readonly nonces = new NonceCache();
  private bad: { since: number; count: number } = { since: 0, count: 0 };

  constructor(
    private readonly ctx: AppContext,
    private readonly store: SealedState,
    private readonly deps: SyncHomeDeps,
  ) {
    this.persisted = store.getPlain(STATUS_KEY, EMPTY);
  }

  private pair(): Pair | null {
    const p = this.store.get<Pair>(PAIR_KEY);
    return p && typeof p.pairId === 'string' && typeof p.secret === 'string' ? p : null;
  }

  status(now = Date.now()): SyncHomeStatus {
    const p = this.pair();
    const paused = this.persisted.pausedUntil !== null && this.persisted.pausedUntil > now;
    return {
      paired: !!p,
      pairedAt: p?.createdAt ?? null,
      passwordSaved: this.deps.passwordSaved(),
      running: this.job?.state === 'working',
      pausedUntil: paused ? this.persisted.pausedUntil : null,
      lastRequestAt: this.persisted.lastRequestAt,
      lastResult: this.persisted.lastResult,
      lastGivenAt: this.persisted.lastGivenAt,
    };
  }

  /** A new pairing (the old one stops working). The code holds the secret: returned once, never logged. */
  createPairing(): string {
    const p = newPairing(this.ctx.config.chromiumInstance);
    this.store.set(PAIR_KEY, { pairId: p.pairId, secret: p.secret.toString('base64url'), createdAt: Date.now() } satisfies Pair);
    this.job = null;
    this.persisted = { ...EMPTY };
    this.save();
    return pairingCode(p);
  }

  removePairing(): void {
    this.store.delete(PAIR_KEY);
    this.store.delete(DEVICE_KEY);
    this.job = null;
    this.persisted = { ...EMPTY };
    this.save();
  }

  /** "Allow again" after a pause. */
  resume(): void {
    this.persisted.failures = 0;
    this.persisted.pausedUntil = null;
    this.save();
  }

  private save(): void {
    this.store.setPlain(STATUS_KEY, this.persisted);
  }

  /** Answers one signed request from the remote. */
  handle(header: string | undefined, now = Date.now()): HomeAnswer {
    const deny: HomeAnswer = { status: 401, code: 'unauthorized', message: 'Not paired.' };
    if (now - this.bad.since > BAD_WINDOW_MS) this.bad = { since: now, count: 0 };
    if (this.bad.count >= BAD_MAX) return { status: 429, code: 'rate_limited', message: 'Too many requests.', retryMs: BAD_WINDOW_MS - (now - this.bad.since) };
    const p = this.pair();
    const req = parseRequest(header);
    const ok = !!p && !!req && verifyRequest(req, { pairId: p.pairId, secret: Buffer.from(p.secret, 'base64url') }, now) && this.nonces.use(req.nonce, now);
    if (!ok || !p || !req) {
      this.bad.count++;
      if (p) this.ctx.repo.audit('sync_request_refused', null);
      return deny;
    }
    const pub = req.pub.toString('base64url');
    if (this.job && now - this.job.at > RESULT_TTL_MS && this.job.state !== 'working') this.job = null;
    const job = this.job;
    if (job && job.pub === pub) {
      if (job.state === 'working') return { status: 202, body: { state: 'working', retryMs: 4000 } };
      this.job = null;
      if (job.state === 'done') return { status: 200, body: { state: 'done', box: job.box! } };
      return refusal(job.reason ?? 'error');
    }
    if (job?.state === 'working') return refusal('busy');
    this.persisted.lastRequestAt = now;
    const why = this.mayStart(now);
    if (why) {
      this.persisted.lastResult = why;
      this.save();
      const retryMs = why === 'cooldown' ? MIN_GAP_MS - (now - (this.persisted.lastJobAt ?? now)) : why === 'paused' ? (this.persisted.pausedUntil ?? now) - now : undefined;
      return refusal(why, retryMs);
    }
    this.persisted.lastJobAt = now;
    this.save();
    this.ctx.repo.audit('sync_session_requested', null);
    const fresh: Job = { pub, state: 'working', at: now };
    this.job = fresh;
    void this.run(fresh, { pairId: p.pairId, secret: Buffer.from(p.secret, 'base64url') }, req.pub);
    return { status: 202, body: { state: 'working', retryMs: 8000 } };
  }

  private mayStart(now: number): SyncHomeResult | null {
    if (!this.deps.passwordSaved()) return 'no_password';
    if (this.persisted.pausedUntil !== null && this.persisted.pausedUntil > now) return 'paused';
    if (this.persisted.lastJobAt !== null && now - this.persisted.lastJobAt < MIN_GAP_MS) return 'cooldown';
    if (now - this.ctx.ownerInputAt < OWNER_QUIET_MS) return 'busy';
    return null;
  }

  private async run(job: Job, pair: { pairId: string; secret: Buffer }, pub: Buffer): Promise<void> {
    let result: SyncHomeResult;
    try {
      const device = this.store.get<SessionCookie[]>(DEVICE_KEY) ?? [];
      const r = await this.deps.separateLogin(device);
      if (r.ok) {
        if (r.device.length) this.store.set(DEVICE_KEY, r.device);
        const payload = Buffer.from(JSON.stringify({ v: 1, cookies: r.cookies }), 'utf8');
        job.box = sealForRemote(pair, pub, payload);
        payload.fill(0);
        job.state = 'done';
        result = 'given';
      } else {
        job.state = 'failed';
        result = r.reason === 'not_saved' ? 'no_password' : r.reason;
        job.reason = result;
      }
    } catch (err) {
      job.state = 'failed';
      job.reason = result = 'error';
      this.ctx.log.warn({ err: (err as Error).message }, 'session sync: separate login failed');
    }
    job.at = Date.now();
    this.persisted.lastResult = result;
    if (result === 'given') {
      this.persisted.failures = 0;
      this.persisted.lastGivenAt = job.at;
    } else if (result === 'failed' || result === 'challenge' || result === 'error' || result === 'no_form') {
      // Not counted: the screen was busy (owner or the automatic login), or nothing was typed.
      if (++this.persisted.failures >= MAX_FAILURES) this.persisted.pausedUntil = job.at + PAUSE_MS;
    }
    if (result === 'busy') this.persisted.lastJobAt = null; // nothing happened on Instagram: may try again soon
    this.save();
    this.ctx.repo.audit('sync_session_result', null, result);
    this.ctx.log.info({ result }, 'session sync: separate login for the remote');
  }
}

function refusal(reason: SyncHomeResult, retryMs?: number): HomeAnswer {
  const status = reason === 'cooldown' || reason === 'paused' ? 429 : 409;
  return { status, code: `sync_${reason}`, message: 'The home could not make a session.', ...(retryMs !== undefined ? { retryMs: Math.max(0, retryMs) } : {}) };
}
