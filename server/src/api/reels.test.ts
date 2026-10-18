import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';

describe('reels API', () => {
  let h: Harness;
  let c: TestClient;
  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
  });
  afterEach(async () => {
    await h.close();
  });

  it('needs a login and a connected Instagram', async () => {
    expect((await h.client().req('GET', '/api/reels')).status).toBe(401);
    expect((await h.client().req('GET', '/api/reels/media/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(401);
    expect((await c.req('GET', '/api/reels')).status).toBe(503);
    expect((await c.req('GET', '/api/reels/media/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(503);
  });

  it('validates its input', async () => {
    expect((await c.req('GET', '/api/reels?cursor=a&x=1')).status).toBe(400);
    expect((await c.req('GET', '/api/reels/media/..%2Fetc')).status).toBe(400);
  });
});
