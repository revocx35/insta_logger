import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullIg, type IgController } from '../context.js';
import { Errors } from '../errors.js';
import type { SessionCookie } from '../ig/cookies.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';

const UID = '1234567890';
const SID = `${UID}%3AabcdEFGHijklmn%3A12%3AAYc-signature_here`;
const CURL = `curl 'https://www.instagram.com/' -b 'csrftoken=tok; ds_user_id=${UID}; sessionid=${SID}; _ga=x'`;

class SessionIg extends NullIg {
  imported: SessionCookie[][] = [];
  fail: Error | null = null;
  override async importSession(cookies: SessionCookie[]): Promise<void> {
    if (this.fail) throw this.fail;
    this.imported.push(cookies);
  }
}

describe('POST /api/ig/session', () => {
  let h: Harness;
  let c: TestClient;
  let ig: SessionIg;

  beforeEach(async () => {
    ig = new SessionIg();
    h = await makeHarness({}, { ig: () => ig as IgController });
    c = h.client();
    await c.signup();
  });
  afterEach(async () => {
    await h.close();
  });

  it('hands the Instagram cookies to the browser and audits without values', async () => {
    const r = await c.req('POST', '/api/ig/session', { cookies: CURL });
    expect(r.status).toBe(200);
    expect(ig.imported).toEqual([
      [
        { name: 'csrftoken', value: 'tok' },
        { name: 'ds_user_id', value: UID },
        { name: 'sessionid', value: SID },
      ],
    ]);
    const audit = (await c.req('GET', '/api/audit')).body as { event: string; detail: string | null }[];
    const entry = audit.find((a) => a.event === 'ig_session_imported');
    expect(entry?.detail).toBe('3 cookies');
    expect(JSON.stringify(audit)).not.toContain(SID);
  });

  it('rejects input without a session, with generic messages', async () => {
    const r = await c.req('POST', '/api/ig/session', { cookies: 'curl https://www.instagram.com/ -b "csrftoken=tok"' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('tok');
    expect((await c.req('POST', '/api/ig/session', { cookies: 'x'.repeat(40_000) })).status).toBe(400);
    expect((await c.req('POST', '/api/ig/session', { cookies: CURL, extra: 1 })).status).toBe(400);
    expect((await c.req('POST', '/api/ig/session', {})).status).toBe(400);
    expect(ig.imported).toEqual([]);
  });

  it('passes on the controller refusing (already logged in)', async () => {
    ig.fail = Errors.conflict('Instagram is already logged in. Log it out first.');
    expect((await c.req('POST', '/api/ig/session', { cookies: CURL })).status).toBe(409);
  });

  it('requires a session, the CSRF token and our origin', async () => {
    expect((await c.req('POST', '/api/ig/session', { cookies: CURL }, { csrf: null })).status).toBe(403);
    expect((await c.req('POST', '/api/ig/session', { cookies: CURL }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await h.client().req('POST', '/api/ig/session', { cookies: CURL })).status).toBe(401);
    expect(ig.imported).toEqual([]);
  });
});

describe('POST /api/ig/session without Instagram', () => {
  it('is unavailable', async () => {
    const h = await makeHarness();
    const c = h.client();
    await c.signup();
    expect((await c.req('POST', '/api/ig/session', { cookies: CURL })).status).toBe(503);
    await h.close();
  });
});
