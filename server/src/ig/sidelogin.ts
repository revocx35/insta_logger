import type { AutoLogin } from './autologin.js';
import { classifyUrl } from './browser.js';
import type { CdpTarget } from './chromium.js';
import { DEVICE_COOKIES, sessionCookies, type SessionCookie } from './cookies.js';
import { uniform, type Rng } from './humaninput.js';
import { BrowserCdp, sideTargets } from './loginwatch.js';

/*
 * A separate Instagram login for session sync (sync/home.ts): the session handed to another insta_logger must not be
 * this browser's own (one session used from two countries at once is what Instagram ends), so it is made fresh.
 *
 * A throwaway browser context (incognito-like: its own cookie jar, gone when disposed) gets a window on the login page;
 * the saved password goes in exactly like the automatic login (AutoLogin.fillForm: read-only DOM look, human input
 * through VNC), and once the context's jar holds a session its cookies are taken and the context is disposed — no
 * logout, so the session lives on for the other insta_logger. The profile's own tab and session are not touched.
 * The device-id cookies (mid, ig_did, datr) of the last separate login are put back first, so Instagram sees a known
 * device rather than a new one each time.
 *
 * While logged out, nothing is attached to that window either: browser-level commands only (create/dispose context,
 * create/activate target, the context's cookie jar), plus fillForm's short read-only look.
 */

export type SideLoginResult =
  | { ok: true; cookies: SessionCookie[]; device: SessionCookie[] }
  | { ok: false; reason: 'not_saved' | 'busy' | 'no_form' | 'covered' | 'challenge' | 'failed' | 'error' };

export interface SideLoginDeps {
  target: CdpTarget;
  origin: string;
  autoLogin: Pick<AutoLogin, 'exclusive' | 'fillForm'>;
  /** Device cookies kept from the last separate login (may be empty). */
  device: SessionCookie[];
  rng?: Rng;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long Instagram gets after submitting. */
  verdictMs?: number;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
}

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

/** The cookies of Instagram's host among a context's jar. */
export function instagramPairs(cookies: Cookie[], origin: string): [string, string][] {
  const host = new URL(origin).hostname;
  const ig = /(^|\.)instagram\.com$/.test(host) ? 'instagram.com' : host;
  return cookies.filter((c) => c.domain.replace(/^\./, '') === ig || c.domain.endsWith(`.${ig}`)).map((c) => [c.name, c.value] as [string, string]);
}

export async function separateLogin(deps: SideLoginDeps): Promise<SideLoginResult> {
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? sleepFor;
  const verdictMs = deps.verdictMs ?? 60_000;
  const res = await deps.autoLogin.exclusive(async (signal, creds) => {
    const cdp = await BrowserCdp.open(deps.target);
    let contextId: string | null = null;
    let targetId: string | null = null;
    try {
      // disposeOnDetach: if this process dies mid-login, the context goes with the connection.
      ({ browserContextId: contextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true }));
      const host = new URL(deps.origin).hostname;
      const real = /(^|\.)instagram\.com$/.test(host);
      if (deps.device.length) {
        const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
        await cdp.send('Storage.setCookies', {
          browserContextId: contextId,
          cookies: deps.device.map((c) => ({ name: c.name, value: c.value, path: '/', expires, secure: real, ...(real ? { domain: '.instagram.com' } : { url: deps.origin }) })),
        });
      }
      ({ targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${deps.origin}/accounts/login/`, browserContextId: contextId, newWindow: true }));
      sideTargets.add(targetId);
      await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);
      // A new window opens "normal" (tab strip + address bar) even in kiosk mode: fullscreen it like the profile's own,
      // or CSS pixels are no longer screen pixels and every click lands above its field.
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
      // The page loads; a person waits a moment before typing.
      await sleep(uniform(rng, 5_000, 10_000), signal);
      const { bounds } = await cdp.send<{ bounds: { left?: number; top?: number; windowState?: string } }>('Browser.getWindowForTarget', { targetId });
      if (bounds.windowState !== 'fullscreen' || (bounds.left ?? 0) !== 0 || (bounds.top ?? 0) !== 0) return { ok: false as const, reason: 'covered' as const };
      const filled = await deps.autoLogin.fillForm(deps.target, { id: targetId, url: `${deps.origin}/accounts/login/` }, creds, signal, { manual: false });
      if (filled === 'no_form' || filled === 'covered' || filled === 'busy') return { ok: false as const, reason: filled };
      const jar = async () => (await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies', { browserContextId: contextId })).cookies;
      const where = async () => {
        const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string }[] }>('Target.getTargets');
        return targetInfos.find((t) => t.targetId === targetId)?.url ?? '';
      };
      const until = Date.now() + verdictMs;
      while (Date.now() < until) {
        await sleep(1500, signal);
        const pairs = instagramPairs(await jar(), deps.origin);
        if (pairs.some(([n]) => n === 'sessionid') && pairs.some(([n]) => n === 'ds_user_id')) {
          // Instagram sets a few more cookies right after the login: give it a moment, then take the jar.
          await sleep(uniform(rng, 2500, 4000), signal);
          const all = instagramPairs(await jar(), deps.origin);
          const cookies = sessionCookies(all);
          const device = cookies.filter((c) => DEVICE_COOKIES.has(c.name));
          return { ok: true as const, cookies, device };
        }
        if (classifyUrl(await where(), deps.origin) === 'challenge') return { ok: false as const, reason: 'challenge' as const };
      }
      return { ok: false as const, reason: 'failed' as const };
    } catch (err) {
      if (signal.aborted || (err as Error).message === 'aborted') return { ok: false as const, reason: 'busy' as const };
      return { ok: false as const, reason: 'error' as const };
    } finally {
      if (contextId) await cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => undefined);
      if (targetId) sideTargets.delete(targetId);
      cdp.close();
    }
  });
  if (res === 'busy' || res === 'not_saved') return { ok: false, reason: res };
  return res;
}
