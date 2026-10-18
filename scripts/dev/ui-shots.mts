/**
 * Screenshots of the web UI in a real browser (light, dark and phone width), for checking the layout by eye.
 * Needs a running stack with data (e.g. `fake-e2e.mts --keep` plus `fake-instagram.mts` started again) and the test
 * browser from README.md on 127.0.0.1:9333.
 *   cd server && npx tsx ../scripts/dev/ui-shots.mts https://localhost:29443 /tmp/shots [password]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { CHAT, GROUP, OTHER } from '../../server/src/testutil/igfixtures.ts';

const BASE = process.argv[2] ?? 'https://localhost:29443';
const OUT = process.argv[3] ?? '/tmp/shots';
const PASSWORD = process.argv[4] ?? 'correct-horse-battery-staple';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1280, height: 820 });
const shot = async (name: string) => {
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot', name);
};
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await shot('01-login');
await page.type('input[autocomplete="username"], input[name="username"]', 'owner');
await page.type('input[type="password"]', PASSWORD);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => undefined), page.keyboard.press('Enter')]);
await page.goto(`${BASE}/chat/${CHAT}`, { waitUntil: 'networkidle2' });
await shot('02-chat-light');
await page.goto(`${BASE}/chat/${GROUP}`, { waitUntil: 'networkidle2' });
await shot('03-group');
await page.goto(`${BASE}/chat/${OTHER}`, { waitUntil: 'networkidle2' });
await shot('04-share');
await page.goto(`${BASE}/deleted`, { waitUntil: 'networkidle2' });
await shot('05-unsent');
await page.goto(`${BASE}/instagram`, { waitUntil: 'networkidle2' });
await shot('06-instagram');
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle2' });
await shot('07-settings');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.goto(`${BASE}/chat/${CHAT}`, { waitUntil: 'networkidle2' });
await shot('08-chat-dark');
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await shot('09-phone-list');
await page.goto(`${BASE}/chat/${CHAT}`, { waitUntil: 'networkidle2' });
await shot('10-phone-chat');
await ctx.close();
await browser.disconnect();
