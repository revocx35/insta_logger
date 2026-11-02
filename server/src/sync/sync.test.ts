import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullIg, type IgController } from '../context.js';
import { generateX25519 } from '../crypto/primitives.js';
import type { SessionCookie } from '../ig/cookies.js';
import type { TabLook } from '../ig/loginwatch.js';
import { pickTab, sideTargets } from '../ig/loginwatch.js';
import { instagramPairs, type SideLoginResult } from '../ig/sidelogin.js';
import { makeHarness, PASSWORD, type Harness, type TestClient } from '../testutil/harness.js';
import { MIN_GAP_MS, MAX_FAILURES as HOME_MAX_FAILURES } from './home.js';
import {
  HEADER,
  NonceCache,
  newPairing,
  openFromHome,
  pairingCode,
  parsePairingCode,
  parseRequest,
  sealForRemote,
  signRequest,
  verifyRequest,
} from './protocol.js';
import { normalizeHomeUrl, SyncRemote } from './remote.js';
import { SealedState } from './store.js';

const UID = '1234567890';
const SID = `${UID}%3AsideLoginSession%3A12%3AAYc-signature`;
const COOKIES: SessionCookie[] = [
  { name: 'csrftoken', value: 'csrf-side' },
  { name: 'ds_user_id', value: UID },
  { name: 'sessionid', value: SID },
  { name: 'mid', value: 'device-mid' },
];
const LOGIN: TabLook = { tab: { id: 't1', url: 'https://www.instagram.com/accounts/login/' }, kind: 'login', userId: null };

/* ------------------------------------------------------------ protocol */

describe('sync protocol', () => {
  it('pairing codes round-trip and reject anything else', () => {
    const p = newPairing(3);
    const code = pairingCode(p);
    expect(code).toMatch(/^igls1\.3\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    const back = parsePairingCode(`  ${code}\n`)!;
    expect(back.tenant).toBe(3);
    expect(back.pairId).toBe(p.pairId);
    expect(back.secret.equals(p.secret)).toBe(true);
    for (const bad of ['', 'igls1', code.replace('igls1', 'igls2'), code.slice(0, -2), code.replace('.3.', '.0.'), code.replace('.3.', '.x.'), `${code}.x`]) {
      expect(parsePairingCode(bad)).toBeNull();
    }
  });

  it('signs requests: right secret, fresh, untampered', () => {
    const p = newPairing(1);
    const pub = generateX25519().publicRaw;
    const now = 1_800_000_000_000;
    const r = parseRequest(signRequest(p, pub, now))!;
    expect(verifyRequest(r, p, now)).toBe(true);
    expect(verifyRequest(r, p, now + 3 * 60_000)).toBe(false); // too old
    expect(verifyRequest(r, newPairing(1), now)).toBe(false); // another pairing
    expect(verifyRequest(r, { ...p, secret: newPairing(1).secret }, now)).toBe(false);
    const other = generateX25519().publicRaw;
    expect(verifyRequest({ ...r, pub: other }, p, now)).toBe(false); // swapped key
    expect(verifyRequest({ ...r, ts: now + 1 }, p, now)).toBe(false);
    for (const bad of [undefined, '', 'v1.x', signRequest(p, pub, now).replace('v1.', 'v2.'), 'v1.' + 'a'.repeat(400)]) expect(parseRequest(bad)).toBeNull();
  });

  it('accepts each nonce once', () => {
    const n = new NonceCache(1000);
    expect(n.use('a', 0)).toBe(true);
    expect(n.use('a', 500)).toBe(false);
    expect(n.use('a', 2000)).toBe(true); // window passed
  });

  it('seals the session for the one remote key and pairing', () => {
    const p = newPairing(1);
    const mine = generateX25519();
    const box = sealForRemote(p, mine.publicRaw, Buffer.from('cookies'));
    expect(openFromHome(p, mine, box).toString()).toBe('cookies');
    expect(() => openFromHome(p, generateX25519(), box)).toThrow(); // another key pair
    expect(() => openFromHome({ ...p, secret: newPairing(1).secret }, mine, box)).toThrow(); // another pairing
    expect(() => openFromHome({ ...p, pairId: newPairing(1).pairId }, mine, box)).toThrow();
    const raw = Buffer.from(box, 'base64url');
    raw[raw.length - 1]! ^= 1;
    expect(() => openFromHome(p, mine, raw.toString('base64url'))).toThrow();
  });

  it('normalizes the home address', () => {
    expect(normalizeHomeUrl(' http://10.0.0.2:8091/ ')).toBe('http://10.0.0.2:8091');
    expect(normalizeHomeUrl('https://igl.example/base/')).toBe('https://igl.example/base');
    for (const bad of ['', 'ftp://x', 'http://u:p@x', 'http://x/?a=1', 'http://x/#f', 'javascript:alert(1)', 'x'.repeat(400)]) expect(normalizeHomeUrl(bad)).toBeNull();
  });

  it("keeps the separate login's window out of the tab choice, and picks Instagram's cookies", () => {
    sideTargets.add('side');
    const tabs = [
      { id: 'side', url: 'https://www.instagram.com/accounts/login/' },
      { id: 'main', url: 'https://www.instagram.com/direct/inbox/' },
    ];
    expect(pickTab(tabs, 'https://www.instagram.com')?.id).toBe('main');
    sideTargets.delete('side');
    expect(
      instagramPairs(
        [
          { name: 'sessionid', value: 's', domain: '.instagram.com' },
          { name: 'datr', value: 'd', domain: '.facebook.com' },
          { name: 'mid', value: 'm', domain: 'www.instagram.com' },
        ],
        'https://www.instagram.com',
      ),
    ).toEqual([
      ['sessionid', 's'],
      ['mid', 'm'],
    ]);
  });
});

/* ------------------------------------------------ home + remote, end to end */

class HomeIg extends NullIg {
  passwordSaved = true;
  next: SideLoginResult = { ok: true, cookies: COOKIES, device: COOKIES.filter((c) => c.name === 'mid') };
  logins: SessionCookie[][] = [];
  override autoLoginStatus() {
    return { ...super.autoLoginStatus(), saved: this.passwordSaved };
  }
  override async separateLogin(device: SessionCookie[]): Promise<SideLoginResult> {
    this.logins.push(device);
    return this.next;
  }
}

describe('session sync', () => {
  let home: Harness;
  let owner: TestClient;
  let ig: HomeIg;
  let remoteH: Harness;
  let imported: SessionCookie[][];
  let failImport = false;

  /** The remote's fetch, answered by the home's app in-process. */
  const homeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const r = await home.app.inject({ method: 'GET', url: u.pathname, headers: init?.headers as Record<string, string> });
    return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const makeRemote = () =>
    new SyncRemote(remoteH.ctx, new SealedState(remoteH.ctx.repo, remoteH.dir), {
      importSession: async (c) => {
        if (failImport) throw new Error('no');
        imported.push(c);
      },
      fetch: homeFetch,
      sleep: async () => undefined,
    });

  const pair = async () => {
    const r = await owner.req('POST', '/api/sync/home/pair', { password: PASSWORD });
    expect(r.status).toBe(200);
    return (r.body as { code: string }).code;
  };

  beforeEach(async () => {
    ig = new HomeIg();
    home = await makeHarness({}, { ig: () => ig as IgController });
    owner = home.client();
    await owner.signup();
    remoteH = await makeHarness();
    imported = [];
    failImport = false;
  });
  afterEach(async () => {
    await home.close();
    await remoteH.close();
  });

  it('pairs only with the password, shows the code once and keeps it out of logs and the database', async () => {
    expect((await owner.req('POST', '/api/sync/home/pair', { password: 'wrong-password-123' })).status).toBe(401);
    expect((await owner.req('POST', '/api/sync/home/pair', {})).status).toBe(400);
    expect((await home.client().req('GET', '/api/sync/home')).status).toBe(401);
    const code = await pair();
    const secret = code.split('.')[3]!;
    const st = (await owner.req('GET', '/api/sync/home')).body as Record<string, unknown>;
    expect(st).toMatchObject({ paired: true, passwordSaved: true, running: false });
    expect(JSON.stringify(st)).not.toContain(secret);
    const dump = home.ctx.repo.db.prepare("select value from app_state where key like 'sync%'").all();
    expect(JSON.stringify(dump)).not.toContain(secret);
    const audit = (await owner.req('GET', '/api/audit')).body;
    expect(JSON.stringify(audit)).toContain('sync_paired');
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('gives a separate session to the paired remote, sealed, and the remote imports it', async () => {
    const code = await pair();
    const remote = makeRemote();
    remote.save({ url: 'http://home.test:8091/', code });
    expect(remote.status()).toMatchObject({ configured: true, url: 'http://home.test:8091', enabled: true });
    const t0 = Date.now();
    remote.consider(LOGIN, t0);
    expect(imported).toEqual([]); // settles first
    remote.consider(LOGIN, t0 + 31_000);
    await expect.poll(() => remote.status().lastResult).toBe('logged_in');
    expect(imported).toEqual([COOKIES]);
    expect(ig.logins).toEqual([[]]); // no device cookies the first time
    expect((await owner.req('GET', '/api/sync/home')).body).toMatchObject({ lastResult: 'given', running: false });
  });

  it('refuses unsigned, forged and replayed requests (generic 401) and gives nothing without a pairing', async () => {
    const plain = await home.app.inject({ method: 'GET', url: '/api/sync/session' });
    expect(plain.statusCode).toBe(401);
    const code = await pair();
    const p = parsePairingCode(code)!;
    const pub = generateX25519().publicRaw;
    const forged = signRequest({ ...p, secret: newPairing(1).secret }, pub);
    expect((await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: forged } })).statusCode).toBe(401);
    const good = signRequest(p, pub);
    expect((await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: good } })).statusCode).toBe(202);
    const replay = await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: good } });
    expect(replay.statusCode).toBe(401);
    expect(replay.body).not.toContain('box');
    // Removing the pairing stops it.
    await owner.req('DELETE', '/api/sync/home');
    expect((await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: signRequest(p, pub) } })).statusCode).toBe(401);
    expect(ig.logins.length).toBe(1);
  });

  it('home restraint: cooldown, no password, owner at the screen, pause after failures', async () => {
    const code = await pair();
    const p = parsePairingCode(code)!;
    const ask = async (pub = generateX25519().publicRaw) => home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: signRequest(p, pub) } });
    expect((await ask()).statusCode).toBe(202);
    await expect.poll(() => ig.logins.length).toBe(1);
    const again = await ask();
    expect(again.statusCode).toBe(429);
    expect(JSON.parse(again.body)).toMatchObject({ error: { code: 'sync_cooldown' } });
    expect(JSON.parse(again.body).retryMs).toBeGreaterThan(MIN_GAP_MS - 5000);
    // Fresh pairing resets the status; then the other rules.
    await pair();
    const p2 = parsePairingCode((await owner.req('POST', '/api/sync/home/pair', { password: PASSWORD })).body.code)!;
    const ask2 = async () => home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: signRequest(p2, generateX25519().publicRaw) } });
    ig.passwordSaved = false;
    expect(JSON.parse((await ask2()).body).error.code).toBe('sync_no_password');
    ig.passwordSaved = true;
    home.ctx.ownerInputAt = Date.now();
    expect(JSON.parse((await ask2()).body).error.code).toBe('sync_busy');
    home.ctx.ownerInputAt = 0;
    expect(ig.logins.length).toBe(1);
  });

  it('pauses the home after failed separate logins in a row', async () => {
    const code = await pair();
    const p = parsePairingCode(code)!;
    ig.next = { ok: false, reason: 'failed' };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < HOME_MAX_FAILURES; i++) {
        const fresh = await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: signRequest(p, generateX25519().publicRaw) } });
        expect(fresh.statusCode).toBe(202);
        await expect.poll(() => ig.logins.length).toBe(i + 1);
        vi.setSystemTime(Date.now() + MIN_GAP_MS + 1000); // each failure is a separate request after the gap
      }
      const paused = await home.app.inject({ method: 'GET', url: '/api/sync/session', headers: { [HEADER]: signRequest(p, generateX25519().publicRaw) } });
      expect(JSON.parse(paused.body).error.code).toBe('sync_paused');
    } finally {
      vi.useRealTimers();
    }
    expect(((await owner.req('GET', '/api/sync/home')).body as { pausedUntil: number | null }).pausedUntil).toBeGreaterThan(Date.now());
    expect((await owner.req('POST', '/api/sync/home/resume')).status).toBe(200);
    expect(((await owner.req('GET', '/api/sync/home')).body as { pausedUntil: number | null }).pausedUntil).toBeNull();
  });

  it('remote: wrong pairing, home refusals, browser refusing the cookies, and its own restraint', async () => {
    const code = await pair();
    const remote = makeRemote();
    // A code from another pairing: the home refuses.
    remote.save({ url: 'http://home.test', code: pairingCode(newPairing(1)) });
    const c = (remote as unknown as { config(): Parameters<SyncRemote['run']>[0] }).config();
    expect(await remote.run(c)).toBe('refused');
    remote.save({ url: 'http://home.test', code });
    const c2 = (remote as unknown as { config(): Parameters<SyncRemote['run']>[0] }).config();
    failImport = true;
    expect(await remote.run(c2)).toBe('not_taken');
    expect(await remote.run(c2)).toBe('home_cooldown'); // the home's 15 min gap
    expect(remote.status()).toMatchObject({ paused: false, lastResult: 'home_cooldown' });
    // Cooldown on the remote side too: consider() stays quiet now.
    const before = ig.logins.length;
    const t0 = Date.now();
    remote.consider(LOGIN, t0);
    remote.consider(LOGIN, t0 + 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(ig.logins.length).toBe(before);
    // After a manual logout, nothing until logged in again.
    const fresh = makeRemote();
    fresh.suppress();
    fresh.consider(LOGIN, t0);
    fresh.consider(LOGIN, t0 + 60_000);
    expect(fresh.status().running).toBe(false);
    // Nothing secret in the remote's status, audit or logs.
    expect(JSON.stringify(remote.status())).not.toContain(code.split('.')[3]!);
    const audit = JSON.stringify(remoteH.ctx.repo.listAudit(50));
    expect(audit).toContain('sync_fetch_result');
    expect(audit).not.toContain(SID);
  });

  it('remote settings API: url and code together, write-only code, run needs the login page', async () => {
    const c = remoteH.client();
    await c.signup();
    const code = await pair();
    expect((await c.req('PUT', '/api/sync/remote', { enabled: true })).status).toBe(400);
    expect((await c.req('PUT', '/api/sync/remote', { url: 'http://home.test' })).status).toBe(400);
    expect((await c.req('PUT', '/api/sync/remote', { url: 'ftp://home.test', code })).status).toBe(400);
    expect((await c.req('PUT', '/api/sync/remote', { url: 'http://home.test', code: 'nope' })).status).toBe(400);
    const r = await c.req('PUT', '/api/sync/remote', { url: 'http://home.test', code });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(code.split('.')[3]!);
    expect((await c.req('PUT', '/api/sync/remote', { enabled: false })).body).toMatchObject({ enabled: false, configured: true });
    expect(((await c.req('POST', '/api/sync/remote/run')).body as { result: string }).result).toBe('not_on_login_page');
    expect((await c.req('PUT', '/api/sync/remote', { url: 'http://home.test', code }, { csrf: 'bad' })).status).toBe(403);
    expect((await c.req('DELETE', '/api/sync/remote')).body).toMatchObject({ configured: false });
  });
});
