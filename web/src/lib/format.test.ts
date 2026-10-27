import { describe, expect, it } from 'vitest';
import { formatAgo } from './format';

describe('formatAgo', () => {
  const now = Date.UTC(2026, 9, 27, 12);
  it('gives Instagram-style short relative times', () => {
    expect(formatAgo(null, now)).toBe('');
    expect(formatAgo(now - 20_000, now)).toBe('now');
    expect(formatAgo(now + 5_000, now)).toBe('now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2d');
    expect(formatAgo(now - 15 * 86_400_000, now)).toBe('2w');
    expect(formatAgo(now - 800 * 86_400_000, now)).toBe('2y');
  });
});
