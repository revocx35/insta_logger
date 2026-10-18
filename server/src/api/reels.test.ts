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

  it('likes and comments need a connected Instagram, valid ids and text, and the CSRF token', async () => {
    expect((await c.req('POST', '/api/reels/123/like', { like: true })).status).toBe(503);
    expect((await c.req('POST', '/api/reels/123/like', { like: true }, { csrf: null })).status).toBe(403);
    expect((await c.req('POST', '/api/reels/12a/like', { like: true })).status).toBe(400);
    expect((await c.req('POST', '/api/reels/123/like', { like: 'yes' })).status).toBe(400);
    expect((await c.req('POST', '/api/reels/123/comments', { text: '   ' })).status).toBe(400);
    expect((await c.req('POST', '/api/reels/123/comments', { text: 'x'.repeat(2201) })).status).toBe(400);
    expect((await c.req('POST', '/api/reels/123/comments', { text: 'nice' })).status).toBe(503);
    expect((await c.req('GET', '/api/reels/123/comments')).status).toBe(503);
  });

  it('validates its input', async () => {
    expect((await c.req('GET', '/api/reels?cursor=a&x=1')).status).toBe(400);
    expect((await c.req('GET', '/api/reels/media/..%2Fetc')).status).toBe(400);
  });
});
