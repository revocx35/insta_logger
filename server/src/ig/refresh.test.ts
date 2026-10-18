import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testutil/harness.js';
import { REFRESH_JITTER_MS, refreshDelay } from './service.js';

describe('scheduled session refresh', () => {
  it('waits the interval ± up to 10 minutes, at random', () => {
    const two = 2 * 3600_000;
    expect(refreshDelay(2, () => 0)).toBe(two - REFRESH_JITTER_MS);
    expect(refreshDelay(2, () => 0.5)).toBe(two);
    expect(refreshDelay(2, () => 0.999999)).toBeLessThanOrEqual(two + REFRESH_JITTER_MS);
    for (let i = 0; i < 200; i++) {
      const d = refreshDelay(1);
      expect(d).toBeGreaterThanOrEqual(3600_000 - REFRESH_JITTER_MS);
      expect(d).toBeLessThanOrEqual(3600_000 + REFRESH_JITTER_MS);
    }
    expect(new Set(Array.from({ length: 20 }, () => refreshDelay(2))).size).toBeGreaterThan(1);
  });

  it('is on by default every 2 hours, and 1–24 hours can be chosen', async () => {
    const h = await makeHarness();
    const c = h.client();
    await c.signup();
    const s = (await c.req('GET', '/api/settings')).body as { sessionRefresh: boolean; sessionRefreshHours: number };
    expect(s).toMatchObject({ sessionRefresh: true, sessionRefreshHours: 2 });
    expect((await c.req('PUT', '/api/settings', { sessionRefreshHours: 6 })).body).toMatchObject({ sessionRefreshHours: 6 });
    expect((await c.req('PUT', '/api/settings', { sessionRefresh: false })).body).toMatchObject({ sessionRefresh: false });
    expect((await c.req('PUT', '/api/settings', { sessionRefreshHours: 0 })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { sessionRefreshHours: 25 })).status).toBe(400);
    await h.close();
  });
});
