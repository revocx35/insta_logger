import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { IgState, IgStatus } from '../../../shared/api.js';
import type { AppContext, IgController, IgWebSource } from '../context.js';
import { IgClient } from './api.js';
import { refreshAvatars } from './avatars.js';
import { cdpReachable, classifyUrl, closeOtherTabs, pickInstagramTab, resolveBrowserUrl, type PageKind } from './browser.js';
import type { RawDelta } from './dgw.js';
import { DocIds } from './docs.js';
import { Ingest, type Me } from './ingest.js';
import { setTestMediaOrigin } from './mapper.js';
import { MediaQueue } from './media.js';
import { Errors } from '../errors.js';
import type { SessionCookie } from './cookies.js';
import { lookAtTab, nextLoginStep, setSessionCookies, steerTab, type TabLook } from './loginwatch.js';
import { IgPage, IgRequestError } from './page.js';
import { Sender } from './sender.js';
import { INITIAL_SYNC_KEY, Sync } from './sync.js';

const ME_KEY = 'ig_me';
const CHECK_INTERVAL_MS = 10_000;
const AVATAR_INTERVAL_MS = 30 * 60_000;
const WATCHDOG_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
/** The tab goes back to the inbox after this long elsewhere (an open thread would mark new messages as seen). */
const AWAY_FROM_INBOX_MS = 2 * 60_000;
/** No frame at all from the message stream for this long while ready: reload the tab. */
const STREAM_SILENCE_MS = 20 * 60_000;
const RESNAPSHOT_DELAY_MS = 30_000;
/** While logged out: how often the tab and the cookie jar are looked at (from outside, see loginwatch.ts). */
const LOGIN_POLL_MS = 3_000;
const LOGIN_TEXT = 'Log in to Instagram on the Instagram screen';
const CHALLENGE_TEXT = 'Instagram asks for a confirmation: answer it on the Instagram screen';

/**
 * The Instagram integration: keeps one Instagram Web tab (in the Chromium container) on the inbox, reads its message
 * stream passively, imports history, reconciles, downloads media and sends — all through that tab.
 */
export class IgService implements IgController {
  private browser: Browser | null = null;
  private tab: IgPage | null = null;
  private client: IgClient | null = null;
  private state: IgState = 'idle';
  private detail: string | undefined;
  private since = Date.now();
  private me: IgStatus['me'];
  private meIds: Me = { fbids: new Set(), igId: null };
  private syncInfo: IgStatus['sync'] = null;
  private lastEventAt: number | null = null;
  private connecting = false;
  private stopped = false;
  private attempt = 0;
  private generation = 0;
  private readyGen = -1;
  private awaySince: number | null = null;
  private checking = false;
  private watchdogFailures = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private avatarTimer: NodeJS.Timeout | null = null;
  private resnapshotTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Deltas that arrived before the logged-in account was known (applied right after). */
  private early: RawDelta[] = [];

  readonly docs: DocIds;
  readonly media: MediaQueue;
  readonly ingest: Ingest;
  readonly sync: Sync;
  readonly sender: Sender;

  constructor(private readonly ctx: AppContext) {
    setTestMediaOrigin(ctx.config.igWebOrigin === 'https://www.instagram.com' ? null : ctx.config.igWebOrigin);
    this.docs = new DocIds({ get: (k) => ctx.repo.getState(k), set: (k, v) => ctx.repo.setState(k, v) });
    const live = () => (this.state === 'ready' || this.state === 'syncing' ? this.client : null);
    this.loadMe();
    this.ingest = new Ingest(
      ctx,
      {
        getThread: async (chatId) => {
          const c = live();
          return c ? c.thread(chatId) : null;
        },
      },
      { enqueue: (id, p) => this.media.enqueue(id, p) },
      () => this.meIds,
    );
    this.media = new MediaQueue(ctx, {
      downloader: () => (live() && this.tab ? this.tab.downloader : null),
      sources: this.ingest.sources,
      refresh: (row) => this.sync.refetchAround(row),
      ownUpload: (id) => this.sender.isUploading(id),
    });
    const api = () => {
      const c = live();
      if (!c) throw new IgRequestError('login', 'Instagram is not connected.');
      return c;
    };
    this.sync = new Sync(
      ctx,
      this.ingest,
      {
        inbox: () => api().inbox(this.deviceId),
        inboxPage: (cursor, viewerFbid) => api().inboxPage(viewerFbid ?? [...this.meIds.fbids][0] ?? '', cursor),
        thread: (id) => api().thread(id),
        messages: (id, opts) => api().messages(id, opts),
      },
      (p) => {
        this.syncInfo = p;
        ctx.events.emit({ type: 'sync_progress', sync: p });
      },
    );
    this.sender = new Sender(ctx, live, (chatId) => this.threadIdOf(chatId));
  }

  private deviceId: string | null = null;

  /* --------------------------------------------------------- status */

  status(): IgStatus {
    const s: IgStatus = { state: this.state, mediaQueue: this.media.size(), since: this.since, sync: this.syncInfo, lastEventAt: this.lastEventAt };
    if (this.detail) s.detail = this.detail;
    if (this.me) s.me = this.me;
    return s;
  }

  private setState(state: IgState, detail?: string): void {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
    this.ctx.log.info({ state, detail }, 'instagram state');
    this.ctx.events.emit({ type: 'ig_state', status: this.status() });
  }

  private loadMe(): void {
    try {
      const raw = this.ctx.repo.getState(ME_KEY);
      const v = raw ? (JSON.parse(raw) as { fbid?: string; igId?: string }) : {};
      this.meIds = { fbids: new Set([...(v.fbid ? [v.fbid] : []), ...this.ctx.repo.meContactIds()]), igId: v.igId ?? null };
    } catch {
      this.meIds = { fbids: new Set(this.ctx.repo.meContactIds()), igId: null };
    }
  }

  /* ------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    if (!this.ctx.config.igEnabled || !this.ctx.repo.hasOwner()) return;
    if (this.browser || this.connecting || this.watchTimer) return;
    this.stopped = false;
    void this.connect();
  }

  /** [fresh]: (re)starting, as opposed to coming back from watching a login (a login page then gets reloaded once). */
  private async connect(fresh = true): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    const gen = ++this.generation;
    if (fresh) this.setState('starting', 'Connecting to Chromium…');
    try {
      const browserURL = await resolveBrowserUrl(this.ctx.config.chromiumHost, this.ctx.config.cdpPort);
      if (!(await cdpReachable(browserURL))) throw new Error('Chromium is not reachable yet');
      // Logged out, or on a login/check page: keep hands off the tab until the login is done.
      const look = await lookAtTab(browserURL, this.ctx.config.igWebOrigin);
      if (gen !== this.generation) return;
      if (nextLoginStep(look, { fresh, strayPolls: 0 }) !== 'attach') {
        this.attempt = 0;
        this.watchLogin(gen, browserURL, look, fresh);
        return;
      }
      const browser = await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: 180_000 });
      if (gen !== this.generation) {
        await browser.disconnect();
        return;
      }
      this.browser = browser;
      browser.on('disconnected', () => this.onBrowserLost(gen));
      const page = await pickInstagramTab(browser, this.ctx.config.igWebOrigin);
      const tab = new IgPage(page, this.ctx.config.igWebOrigin, this.docs, {
        deltas: (d) => gen === this.generation && this.onDeltas(d),
        subscribed: () => gen === this.generation && this.ctx.log.debug('message stream subscribed'),
        resnapshot: () => gen === this.generation && this.scheduleResnapshot(),
      });
      // Attach before (re)loading Instagram, so the message stream socket is seen from its start.
      await tab.attach();
      this.tab = tab;
      this.client = new IgClient(tab);
      page.on('error', () => this.onPageLost(gen, 'Instagram tab crashed'));
      page.on('close', () => this.onPageLost(gen, 'Instagram tab was closed'));
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) void this.check(gen);
      });
      this.setState('starting', 'Loading Instagram…');
      const inbox = `${this.ctx.config.igWebOrigin}/direct/inbox/`;
      const kind = classifyUrl(page.url(), this.ctx.config.igWebOrigin);
      if (kind === 'login' || kind === 'challenge') await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      else await page.goto(inbox, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await closeOtherTabs(browser, page);
      this.attempt = 0;
      this.startChecks(gen);
      await this.check(gen);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.log.warn({ err: msg }, 'instagram connect failed');
      await this.teardown();
      this.scheduleReconnect(msg.includes('not reachable') ? 'Chromium is not reachable' : 'Failed to load Instagram');
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = Math.min(5_000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt++;
    this.setState('error', `${reason}. Retrying in ${Math.round(delay / 1000)}s`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private onBrowserLost(gen: number): void {
    if (gen !== this.generation || this.stopped) return;
    this.ctx.log.warn('connection to Chromium lost');
    void this.teardown().then(() => this.scheduleReconnect('Lost connection to Chromium'));
  }

  private onPageLost(gen: number, reason: string): void {
    if (gen !== this.generation || this.stopped) return;
    this.ctx.log.warn({ reason }, 'Instagram page lost');
    this.ctx.repo.audit('ig_page_lost', null, reason);
    void this.teardown().then(() => {
      this.attempt = 0;
      this.scheduleReconnect(reason);
    });
  }

  private async teardown(): Promise<void> {
    this.generation++;
    this.stopWatch();
    this.media.pause();
    for (const t of [this.checkTimer, this.reconcileTimer, this.avatarTimer]) if (t) clearInterval(t);
    if (this.resnapshotTimer) clearTimeout(this.resnapshotTimer);
    this.checkTimer = this.reconcileTimer = this.avatarTimer = this.resnapshotTimer = null;
    this.readyGen = -1;
    this.early = [];
    const tab = this.tab;
    this.tab = null;
    this.client = null;
    await tab?.detach();
    const b = this.browser;
    this.browser = null;
    if (b) {
      b.removeAllListeners();
      await b.disconnect().catch(() => undefined);
    }
  }

  async restart(): Promise<void> {
    if (!this.ctx.config.igEnabled) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.teardown();
    this.attempt = 0;
    this.stopped = false;
    void this.connect();
  }

  async logout(): Promise<void> {
    const tab = this.tab;
    if (!tab) throw new Error('not connected');
    const page = tab.page;
    await page
      .evaluate(async () => {
        const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        await fetch('/api/v1/web/accounts/logout/ajax/', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...(csrf ? { 'x-csrftoken': decodeURIComponent(csrf[1]!) } : {}) },
          body: 'one_tap_app_login=0',
        }).catch(() => undefined);
      })
      .catch(() => undefined);
    // Also drop the session cookies locally, whatever the server answered.
    const cdp = await page.createCDPSession();
    try {
      for (const name of ['sessionid', 'ds_user_id', 'rur', 'shbid', 'shbts']) {
        await cdp.send('Network.deleteCookies', { name, domain: '.instagram.com' }).catch(() => undefined);
      }
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    this.me = undefined;
    this.readyGen = -1;
    await page.goto(`${this.ctx.config.igWebOrigin}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    this.setState('login', 'Logged out');
  }

  /**
   * Logs in with the session of the owner's own browser (when the login form keeps asking for a captcha): puts the
   * cookies into the browser and opens the inbox; the login watch attaches once Instagram accepts the session.
   */
  async importSession(cookies: SessionCookie[]): Promise<void> {
    if (!this.ctx.config.igEnabled) throw Errors.unavailable('Instagram is not enabled.');
    if (this.state === 'ready' || this.state === 'syncing') throw Errors.conflict('Instagram is already logged in. Log it out first.');
    const origin = this.ctx.config.igWebOrigin;
    const browserURL = await resolveBrowserUrl(this.ctx.config.chromiumHost, this.ctx.config.cdpPort);
    if (!(await cdpReachable(browserURL))) throw Errors.unavailable('The browser is not running yet. Try again in a moment.');
    await setSessionCookies(browserURL, origin, cookies);
    const look = await lookAtTab(browserURL, origin);
    if (look.userId === null) throw Errors.validation('The browser did not take these cookies.');
    await steerTab(browserURL, look.tab, { goto: `${origin}/direct/inbox/` });
    if (!this.watchTimer && !this.browser && !this.connecting) {
      // Not watching (e.g. waiting to reconnect after an error): connect now.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempt = 0;
      void this.connect(false);
    }
  }

  webSource(): IgWebSource | null {
    const tab = this.tab;
    if (!tab || (this.state !== 'ready' && this.state !== 'syncing')) return null;
    return {
      graphql: (name, variables) => tab.graphql(name, variables),
      downloader: tab.downloader,
      meId: this.meIds.igId,
    };
  }

  retryMedia(messageId: string): boolean {
    const row = this.ctx.repo.getMessage(messageId);
    if (!row || row.is_view_once || row.media_id) return false;
    if (!['failed', 'too_large', 'skipped', 'unavailable'].includes(row.media_status)) return false;
    this.ctx.repo.updateMessage(messageId, { media_status: 'pending', media_attempts: 0, updated_at: Date.now() });
    this.media.enqueue(messageId, 'live');
    this.ctx.events.emit({ type: 'message_update', chatId: row.chat_id, messageId, reason: 'media' });
    return true;
  }

  onDataWiped(): void {
    this.ingest.resetCaches();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.media.stop();
    await this.teardown();
  }

  /* --------------------------------------------------- page state */

  private startChecks(gen: number): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.watchdogFailures = 0;
    this.checkTimer = setInterval(() => void this.check(gen), CHECK_INTERVAL_MS);
    this.checkTimer.unref();
  }

  /**
   * Looks at where the tab is and whether Instagram is logged in, and acts on it: waits on login/challenge pages (the
   * owner answers them over VNC), brings the tab back to the inbox, and starts logging once the inbox is open.
   */
  private async check(gen: number): Promise<void> {
    const tab = this.tab;
    if (!tab || gen !== this.generation || this.checking) return;
    this.checking = true;
    try {
      const page = tab.page;
      const alive = await Promise.race([
        page.evaluate(() => typeof (window as unknown as { require?: unknown }).require).then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), WATCHDOG_TIMEOUT_MS).unref()),
      ]).catch(() => false);
      this.watchdogFailures = alive ? 0 : this.watchdogFailures + 1;
      if (this.watchdogFailures >= 3) return this.onPageLost(gen, 'Instagram page unresponsive');
      if (!alive) return;
      const kind: PageKind = classifyUrl(page.url(), this.ctx.config.igWebOrigin);
      if (kind === 'login' || kind === 'challenge') {
        this.pauseLogging();
        this.setLoginState(kind);
        return void this.handOff(gen);
      }
      const userId = await tab.loggedInUserId().catch(() => null);
      if (!userId) {
        if (kind === 'direct' || kind === 'thread') return; // still loading; Instagram redirects to login if needed
        this.pauseLogging();
        await page.goto(`${this.ctx.config.igWebOrigin}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        return;
      }
      if (kind !== 'direct') {
        const now = Date.now();
        this.awaySince ??= now;
        // Right after login Instagram lands on the feed: go to the inbox at once. Elsewhere (the owner browsing over
        // VNC, an open thread), give it a little time first.
        if (kind === 'blank' || kind === 'other' && this.readyGen !== gen || now - this.awaySince > AWAY_FROM_INBOX_MS) {
          this.awaySince = null;
          await page.goto(`${this.ctx.config.igWebOrigin}/direct/inbox/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        }
        if (this.readyGen !== gen) return;
      } else {
        this.awaySince = null;
      }
      if (this.readyGen === gen && this.meIds.igId && userId !== this.meIds.igId) {
        // Someone logged in with another account in the same tab: re-read who it is.
        this.ctx.repo.audit('ig_account_changed', null);
        this.readyGen = -1;
      }
      if (this.readyGen !== gen) {
        // Not awaited: the first history import can take long, and the checks (watchdog, tab position) must go on.
        void this.onReady(gen, userId).catch((err) => this.ctx.log.warn({ err: (err as Error).message }, 'post-login setup failed'));
        return;
      }
      if (this.state !== 'ready' && this.state !== 'syncing') {
        // Back from a login/challenge page in the same connection.
        this.setState(this.sync.busy ? 'syncing' : 'ready');
        this.media.resume();
        this.media.restorePending();
        void this.reconcile(gen);
      }
      const last = tab.lastFrameAt ?? this.since;
      if (kind === 'direct' && this.state === 'ready' && Date.now() - last > STREAM_SILENCE_MS) {
        this.ctx.log.warn('no frames from the message stream for a while; reloading the Instagram tab');
        tab.lastFrameAt = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        void this.reconcile(gen);
      }
    } catch (err) {
      this.ctx.log.debug({ err: (err as Error).message }, 'state check failed');
    } finally {
      this.checking = false;
    }
  }

  private pauseLogging(): void {
    this.media.pause();
  }

  private setLoginState(kind: PageKind): void {
    if (kind === 'challenge') this.setState('challenge', CHALLENGE_TEXT);
    else this.setState('login', LOGIN_TEXT);
  }

  /* ------------------------------------------------- logged out */

  /** The tab went to a login or check page: detach from it and watch it from outside until the login is done. */
  private async handOff(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    await this.teardown();
    this.attempt = 0;
    void this.connect(false);
  }

  /**
   * Waits for the owner to log in over VNC with nothing attached to the tab (see loginwatch.ts): polls where the tab
   * is and whether the cookie jar holds a session, opens the login page when needed, and attaches (connect) once the
   * login is done.
   */
  private watchLogin(gen: number, browserURL: string, first: TabLook, fresh: boolean): void {
    const origin = this.ctx.config.igWebOrigin;
    let stray = 0;
    let failures = 0;
    let busy = true;
    const act = async (look: TabLook, reload: boolean): Promise<void> => {
      if (gen !== this.generation) return;
      const next = nextLoginStep(look, { fresh: reload, strayPolls: stray });
      if (next === 'attach') {
        this.stopWatch();
        void this.connect(false);
        return;
      }
      this.setLoginState(look.kind);
      stray = next === 'wait' && look.kind !== 'login' && look.kind !== 'challenge' ? stray + 1 : 0;
      if (next === 'open_login') await steerTab(browserURL, look.tab, { goto: `${origin}/accounts/login/` });
      else if (next === 'reload') await steerTab(browserURL, look.tab, { reload: true });
    };
    const settle = (p: Promise<void>) =>
      p
        .then(() => {
          failures = 0;
        })
        .catch((err) => {
          if (gen !== this.generation) return;
          this.ctx.log.debug({ err: (err as Error).message }, 'login watch failed');
          if (++failures >= 3) void this.teardown().then(() => this.scheduleReconnect('Lost connection to Chromium'));
        })
        .finally(() => {
          busy = false;
        });
    this.stopWatch();
    this.watchTimer = setInterval(() => {
      if (busy || gen !== this.generation) return;
      busy = true;
      void settle(lookAtTab(browserURL, origin).then((look) => act(look, false)));
    }, LOGIN_POLL_MS);
    this.watchTimer.unref();
    void settle(act(first, fresh));
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private async onReady(gen: number, userId: string): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation || this.readyGen === gen) return;
    this.readyGen = gen;
    try {
      const v = await client.viewer();
      this.deviceId = v.deviceId;
      const igId = v.igId ?? userId;
      if (v.fbid) this.meIds.fbids.add(v.fbid);
      this.meIds.igId = igId;
      this.ctx.repo.setState(ME_KEY, JSON.stringify({ fbid: v.fbid, igId }));
      if (v.fbid) this.ingest.upsertContact({ id: v.fbid, igId, username: v.username, name: v.name, verified: false, avatarUrl: null }, true);
      this.me = { id: v.fbid ?? igId, username: v.username, name: v.name };
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'reading the logged-in account failed');
      this.me = { id: userId, username: null, name: null };
      this.meIds.igId = userId;
    }
    this.ctx.repo.audit('ig_ready', null);
    const early = this.early;
    this.early = [];
    this.applyDeltas(early);
    const firstSync = !this.ctx.repo.getState(INITIAL_SYNC_KEY);
    this.setState(firstSync ? 'syncing' : 'ready', firstSync ? 'Importing chat history…' : undefined);
    this.media.resume();
    this.media.restorePending();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => {
      if (gen === this.generation && this.state === 'ready') void this.reconcile(gen);
    }, this.ctx.config.reconcileMs);
    this.reconcileTimer.unref();
    if (this.avatarTimer) clearInterval(this.avatarTimer);
    this.avatarTimer = setInterval(() => void this.avatars(gen), AVATAR_INTERVAL_MS);
    this.avatarTimer.unref();
    try {
      if (firstSync) await this.sync.initial();
      else await this.sync.reconcile();
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'sync failed');
      if (err instanceof IgRequestError && err.code === 'login') void this.check(gen);
    }
    if (gen !== this.generation) return;
    if (this.state === 'syncing') this.setState('ready');
    void this.avatars(gen);
  }

  private async reconcile(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    try {
      await this.sync.reconcile();
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'reconcile failed');
    }
    void this.avatars(gen);
  }

  private scheduleResnapshot(): void {
    if (this.resnapshotTimer) return;
    const gen = this.generation;
    this.resnapshotTimer = setTimeout(() => {
      this.resnapshotTimer = null;
      if (this.state === 'ready') void this.reconcile(gen);
    }, RESNAPSHOT_DELAY_MS);
    this.resnapshotTimer.unref();
  }

  private async avatars(gen: number): Promise<void> {
    const tab = this.tab;
    if (!tab || gen !== this.generation || (this.state !== 'ready' && this.state !== 'syncing')) return;
    try {
      await refreshAvatars(this.ctx, tab.downloader, this.ingest.avatarUrls);
    } catch (err) {
      this.ctx.log.debug({ err: (err as Error).message }, 'avatar refresh failed');
    }
  }

  /** Instagram's long thread id of a chat (fetched once when the chat row doesn't have it). */
  private async threadIdOf(chatId: string): Promise<string | null> {
    const chat = this.ctx.repo.getChat(chatId);
    if (chat?.thread_id) return chat.thread_id;
    await this.ingest.ensureChat(chatId, true);
    return this.ctx.repo.getChat(chatId)?.thread_id ?? null;
  }

  /* --------------------------------------------------------- events */

  /** Applies deltas in the order Instagram sent them. */
  private onDeltas(deltas: RawDelta[]): void {
    this.lastEventAt = Date.now();
    if (this.readyGen !== this.generation) {
      this.early.push(...deltas);
      if (this.early.length > 5000) this.early.splice(0, this.early.length - 5000);
      return;
    }
    this.applyDeltas(deltas);
  }

  private applyDeltas(deltas: RawDelta[]): void {
    for (const d of deltas) {
      this.chain = this.chain
        .then(() => this.ingest.delta(d))
        .catch((err) => this.ctx.log.error({ err: err instanceof Error ? err.message : String(err), delta: String(d.__typename ?? '').slice(0, 60) }, 'ingest error'));
    }
  }
}
