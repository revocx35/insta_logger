import { AppError } from '../errors.js';

/*
 * Logging in with the session of the owner's own browser. Instagram's login can keep asking the container's browser for
 * a captcha; then the owner logs in on their own computer and pastes that browser's Instagram cookies. Accepted:
 * DevTools "Copy as cURL" (bash: Chrome `-b '…'` or `-H 'cookie: …'`, Firefox `-H 'Cookie: …'`), a plain Cookie header
 * (`name=value; …`), or a cookie-editor JSON export (`[{name, value, domain}, …]`). Only Instagram's own cookie names
 * are kept. The values are credentials: never logged, never stored anywhere but the Chromium profile.
 */

export interface SessionCookie {
  name: string;
  value: string;
}

/** Instagram's cookies worth carrying over: the session and the device ids it was created with. */
const NAMES = new Set(['sessionid', 'ds_user_id', 'csrftoken', 'mid', 'ig_did', 'datr', 'rur', 'shbid', 'shbts', 'ig_nrcb', 'ps_l', 'ps_n', 'ig_direct_region_hint']);
export const SESSION_INPUT_MAX = 32_000;
const VALUE = /^[!-:<-~]{1,1024}$/; // printable ASCII, no spaces, no ';'

const invalid = (msg: string) => new AppError(400, 'invalid_cookies', msg);
const NOTHING = 'Paste the "Copy as cURL" command or the Cookie header of a request to instagram.com from your browser.';

/** Splits a shell command into words (bash quoting: '…', "…", $'…', backslashes, line continuations). */
export function shellWords(input: string): string[] {
  const s = input.replace(/\r\n?/g, '\n');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
      continue;
    }
    has = true;
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw invalid(NOTHING);
      cur += s.slice(i + 1, j);
      i = j + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2;
      for (;;) {
        if (i >= s.length) throw invalid(NOTHING);
        const d = s[i]!;
        if (d === "'") break;
        if (d === '\\' && i + 1 < s.length) {
          const n = s[i + 1]!;
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
            i += 4;
          } else {
            cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
            i += 2;
          }
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) throw invalid(NOTHING);
        const d = s[i]!;
        if (d === '"') break;
        if (d === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

function fromHeader(header: string): [string, string][] {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()] as [string, string]);
}

function fromCurl(command: string): [string, string][] {
  const words = shellWords(command);
  const out: [string, string][] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if ((w === '-b' || w === '--cookie') && next !== undefined) out.push(...fromHeader(next));
    else if (w.startsWith('--cookie=')) out.push(...fromHeader(w.slice('--cookie='.length)));
    else if ((w === '-H' || w === '--header') && next !== undefined && /^cookie\s*:/i.test(next)) out.push(...fromHeader(next.replace(/^cookie\s*:/i, '')));
  }
  return out;
}

function fromJson(text: string): [string, string][] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid(NOTHING);
  }
  if (!Array.isArray(data)) throw invalid(NOTHING);
  const out: [string, string][] = [];
  for (const c of data as unknown[]) {
    if (!c || typeof c !== 'object') continue;
    const { name, value, domain } = c as { name?: unknown; value?: unknown; domain?: unknown };
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (typeof domain === 'string' && !/(^|\.)instagram\.com$/i.test(domain.replace(/^\./, ''))) continue;
    out.push([name, value]);
  }
  return out;
}

/** The Instagram cookies in what the owner pasted. Errors carry generic texts (never a value). */
export function parseSessionCookies(input: string): SessionCookie[] {
  const text = input.trim();
  if (!text || text.length > SESSION_INPUT_MAX) throw invalid(NOTHING);
  const pairs = text.startsWith('[') ? fromJson(text) : /^curl(\.exe)?\s/i.test(text) ? fromCurl(text) : fromHeader(text.replace(/^cookie\s*:/i, ''));
  const found = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (!NAMES.has(name) || found.has(name)) continue;
    if (!VALUE.test(value)) throw invalid(`The value of the "${name}" cookie is not valid. Copy it again.`);
    found.set(name, value);
  }
  if (!found.size) throw invalid(NOTHING);
  const user = found.get('ds_user_id');
  const session = found.get('sessionid');
  if (!session || session.length < 20) throw invalid('The login cookie ("sessionid") is missing. Copy a request that was sent while logged in.');
  if (!user || !/^\d{1,24}$/.test(user)) throw invalid('The account cookie ("ds_user_id") is missing. Copy a request that was sent while logged in.');
  // The session starts with the account id ("<id>%3A…"): a mix of two accounts' cookies would not work.
  const owner = /^(\d{1,24})(%3A|:)/i.exec(session)?.[1];
  if (owner && owner !== user) throw invalid('These cookies belong to two different accounts. Copy them again from one request.');
  return [...found].map(([name, value]) => ({ name, value }));
}
