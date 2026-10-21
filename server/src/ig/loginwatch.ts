import WebSocket from 'ws';
import { classifyUrl, type PageKind } from './browser.js';
import type { CdpTarget } from './chromium.js';

/*
 * Looking at the Instagram tab without touching it. While Instagram is logged out (or asks for a check), insta_logger
 * attaches nothing to the tab: Instagram's login and its reCAPTCHA can notice a debugger in the page (puppeteer turns
 * on the Runtime domain in every frame), and then the login keeps asking for a captcha. Instead the app reads the tab
 * list over Chromium's HTTP endpoint and the cookie jar over a browser-level connection, and attaches once the login
 * is done.
 */

export interface TabInfo {
  id: string;
  url: string;
}

export interface TabLook {
  tab: TabInfo | null;
  kind: PageKind;
  /** The Instagram account id when the browser holds a login session (cookie values are never logged). */
  userId: string | null;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  partitionKey?: unknown;
}

const TIMEOUT_MS = 10_000;

/** The browser's tabs, from Chromium's HTTP endpoint (attaches to nothing). */
export async function listTabs(target: CdpTarget): Promise<TabInfo[]> {
  const r = await fetch(`${target.base}/json/list`, { headers: target.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`tab list: HTTP ${r.status}`);
  const list = (await r.json()) as { id?: unknown; type?: unknown; url?: unknown }[];
  return list
    .filter((t) => t.type === 'page' && typeof t.id === 'string' && typeof t.url === 'string')
    .map((t) => ({ id: t.id as string, url: t.url as string }));
}

/** The tab insta_logger uses: an Instagram tab, else a blank one, else the first (as pickInstagramTab). */
export function pickTab(tabs: TabInfo[], origin: string): TabInfo | null {
  return tabs.find((t) => t.url.startsWith(origin)) ?? tabs.find((t) => classifyUrl(t.url, origin) === 'blank') ?? tabs[0] ?? null;
}

/** The logged-in account from the cookie jar: `sessionid` + `ds_user_id` for Instagram's host (as IgPage.loggedInUserId). */
export function sessionUserId(cookies: Cookie[], origin: string): string | null {
  const host = new URL(origin).hostname;
  const mine = cookies.filter((c) => {
    if (c.partitionKey) return false;
    const d = c.domain.replace(/^\./, '');
    return host === d || host.endsWith(`.${d}`);
  });
  const session = mine.find((c) => c.name === 'sessionid' && c.value.length > 10);
  const user = mine.find((c) => c.name === 'ds_user_id' && /^\d{1,24}$/.test(c.value));
  return session && user ? user.value : null;
}

export type LoginStep = 'attach' | 'wait' | 'open_login' | 'reload';

/**
 * What to do while logged out: attach once there is a session and the tab has left the login/check pages; open the
 * login page when the tab is blank or stays elsewhere (Instagram's own pages redirect to it by themselves, so they get
 * a few polls first); reload a login/check page once when (re)starting, so cookies set meanwhile take effect.
 */
export function nextLoginStep(look: TabLook, opts: { fresh: boolean; strayPolls: number }): LoginStep {
  const onLoginPage = look.kind === 'login' || look.kind === 'challenge';
  if (!look.tab) return 'open_login';
  if (look.userId && !onLoginPage) return 'attach';
  if (onLoginPage) return opts.fresh ? 'reload' : 'wait';
  if (look.kind === 'blank') return 'open_login';
  return opts.strayPolls < 3 ? 'wait' : 'open_login';
}

/** A short-lived browser-level CDP connection: no tab is attached unless a command does it explicitly. */
export class BrowserCdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData) => {
      let d: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        d = JSON.parse(String(data)) as typeof d;
      } catch {
        return;
      }
      const p = d.id === undefined ? undefined : this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id!);
      if (d.error) p.reject(new Error(`CDP: ${d.error.message ?? 'error'}`));
      else p.resolve(d.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async open(target: CdpTarget): Promise<BrowserCdp> {
    // The browser-level WebSocket of the tenant's instance, behind the manager's token-checked relay.
    const url = await target.wsUrl();
    const ws = new WebSocket(url, { headers: target.headers });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timed out'));
      }, TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', () => {
        clearTimeout(t);
        reject(new Error('CDP connect failed'));
      });
    });
    return new BrowserCdp(ws);
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Where the Instagram tab is and whether the browser is logged in to Instagram, without attaching to the tab. */
export async function lookAtTab(target: CdpTarget, origin: string): Promise<TabLook> {
  const tab = pickTab(await listTabs(target), origin);
  const cdp = await BrowserCdp.open(target);
  try {
    const { cookies } = await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies');
    return { tab, kind: tab ? classifyUrl(tab.url, origin) : 'blank', userId: sessionUserId(cookies, origin) };
  } finally {
    cdp.close();
  }
}

/** Loads [url] in the tab (or reloads it), attached for that one command only. Opens a tab when there is none. */
export async function steerTab(target: CdpTarget, tab: TabInfo | null, action: { goto: string } | { reload: true }): Promise<void> {
  const cdp = await BrowserCdp.open(target);
  try {
    if (!tab) {
      await cdp.send('Target.createTarget', { url: 'goto' in action ? action.goto : 'about:blank' });
      return;
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab.id, flatten: true });
    try {
      if ('goto' in action) await cdp.send('Page.navigate', { url: action.goto }, sessionId);
      else await cdp.send('Page.reload', {}, sessionId);
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  } finally {
    cdp.close();
  }
}

/**
 * Puts a session from the owner's own browser into the cookie jar (browser-level; no tab attached). Instagram's
 * cookies live on `.instagram.com`, Secure; `sessionid` is HttpOnly. A test origin gets host-only cookies.
 */
export async function setSessionCookies(target: CdpTarget, origin: string, cookies: { name: string; value: string }[]): Promise<void> {
  const real = /(^|\.)instagram\.com$/.test(new URL(origin).hostname);
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const cdp = await BrowserCdp.open(target);
  try {
    await cdp.send('Storage.setCookies', {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        path: '/',
        expires,
        httpOnly: c.name === 'sessionid',
        ...(real ? { domain: '.instagram.com', secure: true } : { url: origin }),
      })),
    });
  } finally {
    cdp.close();
  }
}
