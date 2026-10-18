import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseSessionCookies, SESSION_INPUT_MAX, shellWords } from './cookies.js';

const UID = '1234567890';
const SID = `${UID}%3AabcdEFGHijklmn%3A12%3AAYc-signature_here`;
const RUR = String.raw`"CLN\0541234567890\0541792330000:01f7abc"`;
const asMap = (list: { name: string; value: string }[]) => Object.fromEntries(list.map((c) => [c.name, c.value]));

function rejects(input: string): AppError {
  try {
    parseSessionCookies(input);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).statusCode).toBe(400);
    return e as AppError;
  }
  throw new Error('accepted');
}

describe('parseSessionCookies', () => {
  it('reads Chrome "Copy as cURL" (-b)', () => {
    const curl = `curl 'https://www.instagram.com/api/graphql' \\
  -H 'accept: */*' \\
  -b 'csrftoken=AbCdEf123; datr=XyZ_abc; ig_did=0C8F3B2A-1111-2222-3333-444455556666; mid=ZxYwVQALAAE; ds_user_id=${UID}; sessionid=${SID}; rur=${RUR}; wd=1280x720' \\
  -H 'origin: https://www.instagram.com' \\
  --data-raw 'av=1&__d=www'`;
    expect(asMap(parseSessionCookies(curl))).toEqual({
      csrftoken: 'AbCdEf123',
      datr: 'XyZ_abc',
      ig_did: '0C8F3B2A-1111-2222-3333-444455556666',
      mid: 'ZxYwVQALAAE',
      ds_user_id: UID,
      sessionid: SID,
      rur: RUR,
    });
  });

  it("reads Chrome's $'…' quoting and Windows line ends", () => {
    const curl = `curl 'https://www.instagram.com/' \\\r\n  -b $'ds_user_id=${UID}; sessionid=${SID}; rur="CLN\\\\0541234"; csrftoken=x\\'y'`;
    expect(asMap(parseSessionCookies(curl))).toMatchObject({ ds_user_id: UID, sessionid: SID, rur: String.raw`"CLN\0541234"`, csrftoken: "x'y" });
  });

  it('reads Firefox "Copy as cURL" (-H Cookie) and a plain Cookie header', () => {
    const ff = `curl 'https://www.instagram.com/' -H 'User-Agent: Mozilla/5.0' -H 'Cookie: sessionid=${SID}; ds_user_id=${UID}; csrftoken=tok'`;
    expect(asMap(parseSessionCookies(ff))).toEqual({ sessionid: SID, ds_user_id: UID, csrftoken: 'tok' });
    expect(asMap(parseSessionCookies(`Cookie: ds_user_id=${UID}; sessionid=${SID}`))).toEqual({ ds_user_id: UID, sessionid: SID });
    expect(asMap(parseSessionCookies(`  ds_user_id=${UID};sessionid=${SID};  `))).toEqual({ ds_user_id: UID, sessionid: SID });
  });

  it('reads a cookie-editor JSON export, Instagram cookies only', () => {
    const json = JSON.stringify([
      { domain: '.instagram.com', name: 'sessionid', value: SID, httpOnly: true },
      { domain: '.instagram.com', name: 'ds_user_id', value: UID },
      { domain: '.facebook.com', name: 'datr', value: 'facebook-device' },
      { domain: 'www.instagram.com', name: 'mid', value: 'm1' },
    ]);
    expect(asMap(parseSessionCookies(json))).toEqual({ sessionid: SID, ds_user_id: UID, mid: 'm1' });
  });

  it('keeps only Instagram cookie names, first occurrence wins', () => {
    const r = asMap(parseSessionCookies(`ds_user_id=${UID}; sessionid=${SID}; sessionid=other; _ga=GA1.2; evil=1`));
    expect(r).toEqual({ ds_user_id: UID, sessionid: SID });
  });

  it('needs the session and account cookies of one account', () => {
    expect(rejects(`ds_user_id=${UID}; csrftoken=x`).message).toMatch(/sessionid/);
    expect(rejects(`sessionid=${SID}; csrftoken=x`).message).toMatch(/ds_user_id/);
    expect(rejects(`sessionid=${SID}; ds_user_id=99999`).message).toMatch(/two different accounts/);
    expect(rejects(`sessionid=short; ds_user_id=${UID}`).message).toMatch(/sessionid/);
    expect(rejects(`sessionid=${SID}; ds_user_id=12ab`).message).toMatch(/ds_user_id/);
  });

  it('rejects garbage, bad values and oversized input without echoing values', () => {
    for (const bad of ['', '   ', 'hello world', '{"sessionid":"x"}', "curl 'https://x -b 'unterminated", 'x'.repeat(SESSION_INPUT_MAX + 1)]) rejects(bad);
    const e = rejects(`curl 'https://www.instagram.com/' -H 'Cookie: ds_user_id=${UID}' -b "sessionid=${SID} SECRETPART"`);
    expect(e.message).not.toContain(SID);
    expect(e.message).not.toContain('SECRETPART');
  });
});

describe('shellWords', () => {
  it('handles quotes, escapes and continuations', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\" \\$e" f\\ g \\\n h $'i\\tj\\x41'`)).toEqual(['curl', 'a b', 'c "d" $e', 'f g', 'h', 'i\tjA']);
  });
});
