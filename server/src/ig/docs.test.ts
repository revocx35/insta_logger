import { describe, expect, it } from 'vitest';
import { DEFAULT_DOC_IDS, DocIds } from './docs.js';

const mem = (init?: unknown) => {
  const m = new Map<string, string>();
  if (init !== undefined) m.set('ig_doc_ids', JSON.stringify(init));
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), m };
};

describe('DocIds', () => {
  it('learns ids from the tab and keeps them across restarts', () => {
    const s = mem();
    const d = new DocIds(s);
    expect(d.learn('IGDThreadDetailQuery', '1111111111')).toBe(true);
    expect(d.learn('NotOurs', '2222222222')).toBe(false);
    expect(new DocIds(s).get('IGDThreadDetailQuery')).toBe('1111111111');
  });

  it('drops ids learned against an older default (and old-format entries)', () => {
    const d = new DocIds(mem({ PolarisDirectInboxQuery: '27262915580045003', IGDThreadDetailQuery: { id: '1', base: 'old' } }));
    expect(d.get('PolarisDirectInboxQuery')).toBe(DEFAULT_DOC_IDS.PolarisDirectInboxQuery);
    expect(d.get('IGDThreadDetailQuery')).toBe(DEFAULT_DOC_IDS.IGDThreadDetailQuery);
    const keep = new DocIds(mem({ IGDThreadDetailQuery: { id: '3333333333', base: DEFAULT_DOC_IDS.IGDThreadDetailQuery } }));
    expect(keep.get('IGDThreadDetailQuery')).toBe('3333333333');
  });
});
