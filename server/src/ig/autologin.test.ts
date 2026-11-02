import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullIg, type IgController } from '../context.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { fakeVncServer } from '../testutil/fakevnc.js';
import { AutoLogin, MAX_FAILURES, mayAttempt, validCredentials, type Policy } from './autologin.js';
import type { CdpTarget } from './chromium.js';
import { seeded } from './humaninput.js';
import { pickLoginFields, pickProfileButton, quadRect, type DomNode, type FormLook } from './loginform.js';
import type { TabLook } from './loginwatch.js';

/* ------------------------------------------------------------ the form */

let id = 1;
const el = (name: string, attrs: Record<string, string> = {}, children: DomNode[] = []): DomNode => ({
  nodeId: id,
  backendNodeId: id++,
  nodeType: 1,
  nodeName: name,
  attributes: Object.entries(attrs).flat(),
  children,
});
const text = (v: string): DomNode => ({ nodeId: id, backendNodeId: id++, nodeType: 3, nodeName: '#text', nodeValue: v });

describe('pickLoginFields', () => {
  it("finds Instagram's username, password and Log in button", () => {
    const user = el('INPUT', { name: 'username', type: 'text', 'aria-label': 'Phone number, username, or email' });
    const pass = el('INPUT', { name: 'password', type: 'password' });
    const btn = el('BUTTON', { type: 'submit' }, [el('DIV', {}, [text('Log in')])]);
    const doc = el('#document', {}, [el('HTML', {}, [el('BODY', {}, [el('INPUT', { type: 'hidden', name: 'x' }), el('FORM', {}, [user, pass, btn]), el('A', {}, [text('Forgot password?')])])])]);
    const f = pickLoginFields(doc)!;
    expect(f.username).toBe(user);
    expect(f.password).toBe(pass);
    expect(f.submit).toBe(btn);
  });

  it('handles the email/pass naming and a div button', () => {
    const user = el('INPUT', { name: 'email', type: 'email' });
    const pass = el('INPUT', { name: 'pass', type: 'password' });
    const btn = el('DIV', { role: 'button', tabindex: '0' }, [text('Log in')]);
    const f = pickLoginFields(el('BODY', {}, [user, el('DIV', {}, [pass]), el('DIV', { role: 'button' }, [text('Show')]), btn]))!;
    expect(f.username).toBe(user);
    expect(f.submit).toBe(btn);
  });

  it('password only, or no form at all', () => {
    const pass = el('INPUT', { type: 'password' });
    expect(pickLoginFields(el('BODY', {}, [el('INPUT', { type: 'checkbox' }), pass]))).toEqual({ username: null, password: pass, submit: null });
    expect(pickLoginFields(el('BODY', {}, [el('INPUT', { type: 'text' })]))).toBeNull();
    expect(pickLoginFields(el('BODY', {}, [el('INPUT', { type: 'password', disabled: '' })]))).toBeNull();
  });

  it("finds the profile picker's button (Instagram 2026-11: no form after a logout)", () => {
    // The shape seen on the live page: a settings button, the profile, two nested "Continue" buttons, another profile.
    const picker = () => {
      const cont = el('DIV', { role: 'button', tabindex: '0' }, [el('DIV', { role: 'button' }, [el('SPAN', {}, [text('Continue')])])]);
      const other = el('DIV', { role: 'button', tabindex: '0' }, [el('SPAN', {}, [text('Use another profile')])]);
      const doc = el('BODY', {}, [el('DIV', { role: 'button' }, [el('svg')]), el('IMG'), el('SPAN', {}, [text('Owner.Account')]), cont, other, el('A', {}, [el('SPAN', {}, [text('Create new account')])])]);
      return { doc, cont, other };
    };
    let p = picker();
    expect(pickLoginFields(p.doc)).toBeNull();
    expect(pickProfileButton(p.doc, 'owner.account')).toEqual({ button: p.cont, own: true });
    expect(pickProfileButton(p.doc, '@owner.account')).toEqual({ button: p.cont, own: true });
    p = picker();
    // Another profile (or an email saved as the login): the normal form behind "Use another profile".
    expect(pickProfileButton(p.doc, 'someone.else')).toEqual({ button: p.other, own: false });
    expect(pickProfileButton(p.doc, 'owner@example.org')).toEqual({ button: p.other, own: false });
    expect(pickProfileButton(el('BODY', {}, [el('DIV', { role: 'button' }, [text('Continue')])]), 'u')).toBeNull();
  });

  it('turns a quad into a box', () => {
    expect(quadRect([10, 20, 110, 20, 110, 58, 10, 58])).toEqual({ x: 10, y: 20, width: 100, height: 38 });
  });
});

/* ---------------------------------------------------------- the policy */

describe('mayAttempt', () => {
  const now = 10_000_000;
  const base: Policy = { saved: true, enabled: true, suppressed: false, failures: 0, lastAttemptAt: null, lastSoft: false, loginSince: now - 20_000, settleMs: 8000, ownerInputAt: 0, now };

  it('goes when everything is quiet', () => {
    expect(mayAttempt(base)).toBe(true);
  });

  it('holds back for every restraint rule', () => {
    expect(mayAttempt({ ...base, saved: false })).toBe(false);
    expect(mayAttempt({ ...base, enabled: false })).toBe(false);
    expect(mayAttempt({ ...base, suppressed: true })).toBe(false);
    expect(mayAttempt({ ...base, failures: MAX_FAILURES })).toBe(false);
    expect(mayAttempt({ ...base, loginSince: null })).toBe(false);
    expect(mayAttempt({ ...base, loginSince: now - 3000 })).toBe(false); // page just appeared
    expect(mayAttempt({ ...base, ownerInputAt: now - 30_000 })).toBe(false); // owner is at the screen
    expect(mayAttempt({ ...base, lastAttemptAt: now - 5 * 60_000 })).toBe(false); // cooldown
    expect(mayAttempt({ ...base, lastAttemptAt: now - 11 * 60_000 })).toBe(true);
    expect(mayAttempt({ ...base, lastAttemptAt: now - 3 * 60_000, lastSoft: true })).toBe(true); // form wasn't there: sooner
  });

  it('validates credentials', () => {
    expect(validCredentials('owner', 'pw')).toBe(true);
    expect(validCredentials(' ', 'pw')).toBe(false);
    expect(validCredentials('owner', '')).toBe(false);
    expect(validCredentials('own\ner', 'pw')).toBe(false);
    expect(validCredentials('owner', 'p\u0000w')).toBe(false);
    expect(validCredentials('o'.repeat(101), 'pw')).toBe(false);
  });
});

/* ----------------------------------------------------- storage + attempt */

const LAYOUT = {
  screen: { width: 1280, height: 800 },
  username: { x: 500, y: 250, width: 268, height: 38 },
  password: { x: 500, y: 296, width: 268, height: 38 },
  submit: { x: 500, y: 350, width: 268, height: 32 },
};
const TARGET = {} as CdpTarget;
const LOOK: TabLook = { tab: { id: 't1', url: 'https://www.instagram.com/accounts/login/' }, kind: 'login', userId: null };

describe('AutoLogin', () => {
  let h: Harness;
  let vnc: ReturnType<typeof fakeVncServer>;
  let port: number;
  let reports = 0;
  let formReads = 0;
  let looks: FormLook[] = [];

  const make = () =>
    new AutoLogin(h.ctx, {
      chromium: { vncPassword: async () => 'vncpass1', openVncTunnel: () => vnc.connect(port) },
      report: () => void reports++,
      rng: seeded(42),
      sleep: async () => undefined, // no real waiting in tests
      readForm: async () => {
        formReads++;
        return looks.shift() ?? { ok: true, layout: LAYOUT };
      },
    });

  beforeEach(async () => {
    h = await makeHarness();
    vnc = fakeVncServer('vncpass1');
    port = await vnc.listen();
    reports = 0;
    formReads = 0;
    looks = [];
  });
  afterEach(async () => {
    await vnc.close();
    await h.close();
  });

  const settle = () => new Promise((r) => setTimeout(r, 100));

  it('stores the password sealed, outside the database key, and shows only the username', () => {
    const a = make();
    expect(a.status().saved).toBe(false);
    a.save({ username: 'owner.account', password: 'Sup3r-Secret!' });
    const st = a.status();
    expect(st).toMatchObject({ saved: true, username: 'owner.account', enabled: true, paused: false });
    expect(JSON.stringify(st)).not.toContain('Sup3r-Secret');
    const raw = h.ctx.repo.getState('ig_autologin')!;
    expect(raw).not.toContain('Sup3r-Secret');
    expect(raw).not.toContain('owner.account');
    const keyFile = path.join(h.dir, 'autologin.key');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    // Without the key file the sealed blob is useless.
    fs.rmSync(keyFile);
    expect(a.status().saved).toBe(false);
  });

  it('switches on/off without the password, and forgets everything on remove', () => {
    const a = make();
    expect(() => a.save({ enabled: false })).toThrow();
    a.save({ username: 'u', password: 'p' });
    a.save({ enabled: false });
    expect(a.status()).toMatchObject({ saved: true, enabled: false });
    a.remove();
    expect(a.status()).toMatchObject({ saved: false, enabled: false, username: null });
    expect(fs.existsSync(path.join(h.dir, 'autologin.key'))).toBe(false);
  });

  it('types the saved login through VNC once the login page has settled', async () => {
    const a = make();
    a.save({ username: 'owner.account', password: 'Pw!1' });
    const t0 = Date.now();
    a.consider(TARGET, LOOK, t0);
    await settle();
    expect(formReads).toBe(0); // the page just appeared
    a.consider(TARGET, LOOK, t0 + 13_000);
    await settle();
    expect(formReads).toBe(1);
    expect(vnc.authOk()).toBe(true);
    const keys = vnc.received.filter((b) => b[0] === 4);
    const pointer = vnc.received.filter((b) => b[0] === 5);
    expect(pointer.length).toBeGreaterThan(20);
    // Every key that went down came back up; the button too.
    const down = new Map<number, number>();
    for (const k of keys) down.set(k.readUInt32BE(4), (down.get(k.readUInt32BE(4)) ?? 0) + (k[1] ? 1 : -1));
    expect([...down.values()].every((v) => v === 0)).toBe(true);
    expect(pointer.at(-1)![1]).toBe(0);
    expect(a.status().running).toBe(true); // waiting for Instagram's answer
    expect(a.note()).toMatch(/saved password/);
    // Instagram took it.
    a.onLoggedIn();
    expect(a.status()).toMatchObject({ running: false, lastResult: 'logged_in' });
    const audit = h.ctx.repo.listAudit(20).map((e) => `${e.event}:${e.detail ?? ''}`);
    expect(audit).toContain('ig_autologin_attempt:');
    expect(audit).toContain('ig_autologin_result:logged_in');
    expect(JSON.stringify(audit)).not.toContain('owner.account');
  });

  it('clicks through the profile picker, then types the password', async () => {
    const a = make();
    a.save({ username: 'owner.account', password: 'Pw!1' });
    const button = { x: 684, y: 432, width: 528, height: 44 };
    looks = [
      { ok: 'picker', screen: LAYOUT.screen, button, own: true },
      { ok: false, reason: 'no_form' }, // still loading
      { ok: true, layout: { ...LAYOUT, username: null } },
    ];
    expect(await a.runNow(TARGET, LOOK)).toBe('started');
    await settle();
    expect(formReads).toBe(3);
    const pointer = vnc.received.filter((b) => b[0] === 5);
    // The first press lands on the Continue button.
    const press = pointer.find((b) => b[1] === 1)!;
    const [x, y] = [press.readUInt16BE(2), press.readUInt16BE(4)];
    expect(x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height).toBe(true);
    expect(vnc.received.some((b) => b[0] === 4)).toBe(true); // typed
    expect(a.status().running).toBe(true);
    a.onLoggedIn();
    expect(a.status().lastResult).toBe('logged_in');
  });

  it('"Continue" that logs straight in, and a picker that leads nowhere', async () => {
    const a = make();
    a.save({ username: 'owner.account', password: 'Pw!1' });
    const button = { x: 684, y: 432, width: 528, height: 44 };
    const nothing: FormLook = { ok: false, reason: 'no_form' };
    looks = [{ ok: 'picker', screen: LAYOUT.screen, button, own: true }, nothing, nothing, nothing, nothing];
    await a.runNow(TARGET, LOOK);
    await settle();
    expect(vnc.received.some((b) => b[0] === 4)).toBe(false); // nothing typed
    expect(a.status().running).toBe(true); // waiting: Continue may have logged in
    a.onLoggedIn();
    expect(a.status().lastResult).toBe('logged_in');
    looks = [{ ok: 'picker', screen: LAYOUT.screen, button, own: false }, nothing, nothing, nothing, nothing];
    await a.runNow(TARGET, LOOK);
    await settle();
    expect(a.status()).toMatchObject({ running: false, lastResult: 'no_form' });
  });

  it('stays away after a manual logout, while the owner uses the screen, and on a check', async () => {
    const a = make();
    a.save({ username: 'u', password: 'p' });
    const t0 = Date.now();
    a.suppress();
    a.consider(TARGET, LOOK, t0);
    a.consider(TARGET, LOOK, t0 + 60_000);
    await settle();
    expect(formReads).toBe(0);
    a.onLoggedIn(); // logged in again → next logout is fair game, but the owner is at the screen
    h.ctx.ownerInputAt = Date.now();
    a.consider(TARGET, LOOK, Date.now());
    a.consider(TARGET, LOOK, Date.now() + 60_000);
    await settle();
    expect(formReads).toBe(0);
    h.ctx.ownerInputAt = 0;
    a.consider(TARGET, { ...LOOK, kind: 'challenge' }, Date.now());
    await settle();
    expect(formReads).toBe(0);
  });

  it('a check page after submitting ends the attempt as "challenge"', async () => {
    const a = make();
    a.save({ username: 'u', password: 'p' });
    const t0 = Date.now();
    a.consider(TARGET, LOOK, t0);
    a.consider(TARGET, LOOK, t0 + 13_000);
    await settle();
    a.onChallenge();
    expect(a.status()).toMatchObject({ running: false, lastResult: 'challenge', paused: false });
  });

  it('"Log in now" works on the login page only and resets a pause', async () => {
    const a = make();
    expect(await a.runNow(TARGET, LOOK)).toBe('not_saved');
    a.save({ username: 'u', password: 'p' });
    expect(await a.runNow(TARGET, { ...LOOK, kind: 'direct' })).toBe('not_on_login_page');
    expect(await a.runNow(TARGET, LOOK)).toBe('started');
    await settle();
    expect(formReads).toBe(1);
    expect(await a.runNow(TARGET, LOOK)).toBe('busy');
  });
});

/* ------------------------------------------------------------------ API */

class AutoIg extends NullIg {
  saved: { username?: string; password?: string; enabled?: boolean }[] = [];
  removed = 0;
  override autoLoginStatus() {
    const last = this.saved.filter((s) => s.username).at(-1);
    return { ...super.autoLoginStatus(), saved: !!last && this.removed === 0, username: last?.username ?? null, enabled: true };
  }
  override saveAutoLogin(input: { username?: string; password?: string; enabled?: boolean }): void {
    this.saved.push(input);
  }
  override removeAutoLogin(): void {
    this.removed++;
  }
  override async autoLoginNow() {
    return 'started' as const;
  }
}

describe('/api/ig/autologin', () => {
  let h: Harness;
  let c: TestClient;
  let ig: AutoIg;
  beforeEach(async () => {
    ig = new AutoIg();
    h = await makeHarness({}, { ig: () => ig as IgController });
    c = h.client();
    await c.signup();
  });
  afterEach(async () => {
    await h.close();
  });

  it('saves (write-only), toggles, runs and removes', async () => {
    expect((await c.req('PUT', '/api/ig/autologin', { enabled: true })).status).toBe(400); // nothing saved yet
    expect((await c.req('PUT', '/api/ig/autologin', { username: 'owner' })).status).toBe(400); // password missing
    expect((await c.req('PUT', '/api/ig/autologin', { username: 'owner', password: 'x\ny' })).status).toBe(400);
    expect((await c.req('PUT', '/api/ig/autologin', { username: 'owner', password: 'pw', extra: 1 })).status).toBe(400);
    const r = await c.req('PUT', '/api/ig/autologin', { username: 'owner', password: 'TopSecretPw' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('TopSecretPw');
    expect((r.body as { saved: boolean }).saved).toBe(true);
    expect((await c.req('PUT', '/api/ig/autologin', { enabled: false })).status).toBe(200);
    expect(((await c.req('POST', '/api/ig/autologin/run')).body as { result: string }).result).toBe('started');
    expect((await c.req('DELETE', '/api/ig/autologin')).status).toBe(200);
    expect(ig.removed).toBe(1);
    const audit = JSON.stringify((await c.req('GET', '/api/audit')).body);
    expect(audit).toContain('ig_autologin_saved');
    expect(audit).not.toContain('TopSecretPw');
  });

  it('needs a session and the CSRF token', async () => {
    const anon = h.client();
    expect((await anon.req('GET', '/api/ig/autologin')).status).toBe(401);
    expect((await c.req('PUT', '/api/ig/autologin', { username: 'a', password: 'b' }, { csrf: 'wrong' })).status).toBe(403);
  });
});
