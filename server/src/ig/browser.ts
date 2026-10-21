import type { Browser, Page } from 'puppeteer';

/** Where the Instagram tab is, as far as insta_logger cares. */
export type PageKind = 'direct' | 'thread' | 'login' | 'challenge' | 'other' | 'blank';

export function classifyUrl(url: string, origin: string): PageKind {
  if (!url.startsWith(`${origin}/`) && url !== origin) return url === 'about:blank' || url === '' ? 'blank' : 'other';
  const path = new URL(url).pathname;
  if (/^\/direct\/t\//.test(path)) return 'thread';
  if (/^\/direct(\/|$)/.test(path)) return 'direct';
  if (/^\/accounts\/(login|emailsignup|signup)(\/|$)/.test(path)) return 'login';
  if (/^\/(challenge|two_factor|auth_platform|consent|accounts\/(suspended|disabled|login\/two_factor|two_factor|confirm_email|onetap\/?$))/.test(path)) {
    // "Save your login info?" (onetap) is after a successful login: not something to wait on.
    return /^\/accounts\/onetap/.test(path) ? 'other' : 'challenge';
  }
  return 'other';
}

/**
 * Uses one tab for Instagram: an existing Instagram tab when there is one (the session lives in the profile anyway),
 * else a blank one. Extra Instagram tabs are closed (two tabs would both answer the message stream, and a second
 * open thread would send "seen" receipts).
 */
export async function pickInstagramTab(browser: Browser, origin: string): Promise<Page> {
  const pages = await browser.pages();
  const ig = pages.filter((p) => p.url().startsWith(origin));
  let keep: Page | undefined = ig[0] ?? pages.find((p) => classifyUrl(p.url(), origin) === 'blank');
  if (!keep) keep = await browser.newPage();
  for (const p of ig.slice(1)) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  return keep;
}

/** Closes every other tab except [keep] (keeps the VNC screen on Instagram). */
export async function closeOtherTabs(browser: Browser, keep: Page): Promise<void> {
  for (const p of await browser.pages()) if (p !== keep) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  await keep.bringToFront().catch(() => undefined);
}
