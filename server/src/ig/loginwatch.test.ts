import { describe, expect, it } from 'vitest';
import { nextLoginStep, pickTab, sessionUserId, type TabLook } from './loginwatch.js';

const IG = 'https://www.instagram.com';
const cookie = (name: string, value: string, domain = '.instagram.com', extra: Record<string, unknown> = {}) => ({ name, value, domain, ...extra });
const SESSION = cookie('sessionid', '1234567890%3Aabcdefghijkl%3A1');

describe('sessionUserId', () => {
  it('needs both sessionid and ds_user_id for Instagram', () => {
    expect(sessionUserId([SESSION, cookie('ds_user_id', '1234567890')], IG)).toBe('1234567890');
    expect(sessionUserId([cookie('ds_user_id', '1234567890')], IG)).toBeNull();
    expect(sessionUserId([SESSION], IG)).toBeNull();
    expect(sessionUserId([cookie('sessionid', 'short'), cookie('ds_user_id', '1234567890')], IG)).toBeNull();
    expect(sessionUserId([SESSION, cookie('ds_user_id', 'not-a-number')], IG)).toBeNull();
  });

  it('ignores other sites and partitioned cookies', () => {
    expect(sessionUserId([cookie('sessionid', SESSION.value, '.facebook.com'), cookie('ds_user_id', '1', '.facebook.com')], IG)).toBeNull();
    expect(sessionUserId([cookie('sessionid', SESSION.value, '.evilinstagram.com'), cookie('ds_user_id', '1', '.evilinstagram.com')], IG)).toBeNull();
    expect(sessionUserId([{ ...SESSION, partitionKey: { topLevelSite: 'https://example.com' } }, cookie('ds_user_id', '1')], IG)).toBeNull();
  });

  it('matches the test origin host exactly too', () => {
    expect(sessionUserId([cookie('sessionid', SESSION.value, 'fakeig'), cookie('ds_user_id', '42', 'fakeig')], 'http://fakeig:18555')).toBe('42');
  });
});

describe('pickTab', () => {
  it('prefers an Instagram tab, then a blank one, then the first', () => {
    const blank = { id: 'b', url: 'about:blank' };
    const ig = { id: 'i', url: `${IG}/direct/inbox/` };
    const other = { id: 'o', url: 'chrome://newtab/' };
    expect(pickTab([other, blank, ig], IG)).toBe(ig);
    expect(pickTab([other, blank], IG)).toBe(blank);
    expect(pickTab([other], IG)).toBe(other);
    expect(pickTab([], IG)).toBeNull();
  });
});

describe('nextLoginStep', () => {
  const tab = { id: 't', url: '' };
  const look = (kind: TabLook['kind'], userId: string | null = null, t: TabLook['tab'] = tab): TabLook => ({ tab: t, kind, userId });
  const wait = { fresh: false, strayPolls: 0 };

  it('attaches only with a session and away from the login/check pages', () => {
    expect(nextLoginStep(look('direct', '1'), wait)).toBe('attach');
    expect(nextLoginStep(look('other', '1'), wait)).toBe('attach'); // e.g. "save your login info?" right after logging in
    expect(nextLoginStep(look('blank', '1'), wait)).toBe('attach');
    expect(nextLoginStep(look('login', '1'), wait)).toBe('wait'); // stale cookie: Instagram still shows the login page
    expect(nextLoginStep(look('challenge', '1'), wait)).toBe('wait'); // 2FA, captcha, suspended …
  });

  it('leaves login and check pages alone while the owner works on them', () => {
    expect(nextLoginStep(look('login'), wait)).toBe('wait');
    expect(nextLoginStep(look('challenge'), wait)).toBe('wait');
    expect(nextLoginStep(look('login'), { fresh: true, strayPolls: 0 })).toBe('reload');
  });

  it('opens the login page from a blank tab, no tab, or a page that does not redirect', () => {
    expect(nextLoginStep(look('blank'), wait)).toBe('open_login');
    expect(nextLoginStep(look('direct', '1', null), wait)).toBe('open_login');
    expect(nextLoginStep(look('direct'), wait)).toBe('wait');
    expect(nextLoginStep(look('other'), { fresh: false, strayPolls: 2 })).toBe('wait');
    expect(nextLoginStep(look('other'), { fresh: false, strayPolls: 3 })).toBe('open_login');
  });
});
