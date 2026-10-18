import type { CDPSession, Page, WebWorker } from 'puppeteer';
import { decodeSocketMessage, parseJsonExact, type RawDelta } from './dgw.js';
import type { DocIds } from './docs.js';
import type { Downloader, FetchOutcome } from './media.js';

/** An Instagram request failed. `code`: login (logged out), http_<n>, graphql (error in the answer), timeout, network. */
export class IgRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IgRequestError';
  }
}

export interface StreamHandlers {
  deltas(deltas: RawDelta[]): void;
  subscribed(): void;
  resnapshot(): void;
}

/** Request headers worth copying from the tab's own GraphQL requests (app id, ASBD id…). Memory only. */
const COPY_HEADER = /^x-(ig-app-id|asbd-id|bloks-version-id|ig-www-claim|ig-max-touch-points)$/i;
/** Instagram Web's app id, used until the tab's own requests show the current one. */
const DEFAULT_APP_ID = '936619743392459';

const STREAM_PATH = /^\/ws\/(lightspeed|streamcontroller|mqttbypass)\b/;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Everything the app does with the Instagram tab, over one CDP session of its own:
 *  - reads the message stream passively (Network.webSocketFrameReceived on gateway.instagram.com/ws/lightspeed,
 *    also inside workers),
 *  - learns GraphQL document ids and common headers from the tab's own requests,
 *  - runs GraphQL requests from inside the page (same cookies, tokens and origin as Instagram Web itself),
 *  - downloads CDN files through the browser (Network.loadNetworkResource), so the app needs no internet access.
 * Nothing here logs request bodies, cookies or tokens.
 */
export class IgPage {
  private cdp: CDPSession | null = null;
  private readonly workerSessions = new Set<CDPSession>();
  private readonly sockets = new Map<string, boolean>(); // requestId → is a message stream socket
  private readonly headers = new Map<string, string>();
  private frameId: string | null = null;
  private onWorker = (w: WebWorker) => void this.attachSession(w.client, true).catch(() => undefined);
  lastFrameAt: number | null = null;

  constructor(
    readonly page: Page,
    private readonly origin: string,
    private readonly docs: DocIds,
    private readonly handlers: StreamHandlers,
  ) {}

  private gatewayHost(): RegExp {
    // Real Instagram: gateway.instagram.com. The end-to-end test's fake Instagram serves the socket itself.
    const host = new URL(this.origin).host.replace(/\./g, '\\.');
    return this.origin === 'https://www.instagram.com' ? /^gateway\.instagram\.com$/ : new RegExp(`^${host}$`);
  }

  async attach(): Promise<void> {
    const cdp = await this.page.createCDPSession();
    this.cdp = cdp;
    await this.attachSession(cdp, false);
    this.page.on('workercreated', this.onWorker);
    for (const w of this.page.workers()) this.onWorker(w);
  }

  private async attachSession(s: CDPSession, worker: boolean): Promise<void> {
    if (worker) this.workerSessions.add(s);
    const gw = this.gatewayHost();
    s.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
      try {
        const u = new URL(e.url);
        this.sockets.set(e.requestId, gw.test(u.host) && STREAM_PATH.test(u.pathname));
      } catch {
        this.sockets.set(e.requestId, false);
      }
    });
    s.on('Network.webSocketClosed', (e: { requestId: string }) => this.sockets.delete(e.requestId));
    s.on('Network.webSocketFrameReceived', (e: { requestId: string; response: { opcode: number; payloadData: string } }) => {
      // Sockets opened before we attached are unknown: try them (only real stream frames decode to anything).
      const known = this.sockets.get(e.requestId);
      if (known === false || e.response.opcode !== 2 || e.response.payloadData.length > (MAX_FRAME_BYTES * 4) / 3) return;
      const ev = decodeSocketMessage(Buffer.from(e.response.payloadData, 'base64'));
      if (known === undefined) {
        if (!ev.deltas.length && !ev.subscribed) return;
        this.sockets.set(e.requestId, true);
      }
      this.lastFrameAt = Date.now();
      if (ev.subscribed) this.handlers.subscribed();
      if (ev.resnapshot) this.handlers.resnapshot();
      if (ev.deltas.length) this.handlers.deltas(ev.deltas);
    });
    s.on('Network.requestWillBeSent', (e: { request: { url: string; method: string; headers: Record<string, string>; postData?: string } }) => {
      const r = e.request;
      if (r.method !== 'POST' || !r.url.startsWith(`${this.origin}/api/graphql`) && !r.url.startsWith(`${this.origin}/graphql/query`)) return;
      for (const [k, v] of Object.entries(r.headers ?? {})) if (COPY_HEADER.test(k) && typeof v === 'string' && v.length < 512) this.headers.set(k.toLowerCase(), v);
      if (typeof r.postData === 'string') {
        const form = new URLSearchParams(r.postData);
        const name = form.get('fb_api_req_friendly_name');
        const doc = form.get('doc_id');
        if (name && doc) this.docs.learn(name, doc);
      }
    });
    await s.send('Network.enable', { maxPostDataSize: 65536 } as never);
  }

  async detach(): Promise<void> {
    this.page.off('workercreated', this.onWorker);
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.detach().catch(() => undefined);
    this.workerSessions.clear();
    this.sockets.clear();
  }

  /** The stream socket is open (seen at least one frame on it). */
  streamOpen(): boolean {
    for (const v of this.sockets.values()) if (v) return true;
    return false;
  }

  /* -------------------------------------------------------------- GraphQL */

  /** Runs a GraphQL query/mutation the way Instagram Web does and returns its `data`. */
  async graphql<T = unknown>(name: string, variables: unknown, timeoutMs = 30_000): Promise<T> {
    const docId = this.docs.get(name);
    if (!docId) throw new IgRequestError('graphql', `unknown query ${name}`);
    const headers: Record<string, string> = { 'x-ig-app-id': DEFAULT_APP_ID, ...Object.fromEntries(this.headers) };
    const run = this.page.evaluate(
      async (o: { url: string; name: string; docId: string; variables: string; headers: Record<string, string>; timeout: number }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const W = window as any;
        const P: Record<string, string> = {};
        // Right after a (re)load Instagram Web's modules aren't there yet: wait for them (up to 10 s), else the
        // request lacks its tokens and Instagram answers with an HTML page.
        for (let i = 0; i < 40; i++) {
          try {
            if (typeof W.require === 'function' && W.require('getAsyncParams')) break;
          } catch {
            /* not loaded yet */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        try {
          const ap = W.require('getAsyncParams')('POST');
          for (const k of Object.keys(ap)) if (ap[k] !== undefined && ap[k] !== null) P[k] = String(ap[k]);
        } catch {
          /* fall back to the token modules below */
        }
        try {
          if (!P.fb_dtsg) {
            const t = W.require('DTSGInitData')?.token || W.require('DTSGInitialData')?.token;
            if (t) P.fb_dtsg = t;
          }
        } catch {
          /* not logged in */
        }
        try {
          if (!P.lsd) P.lsd = W.require('LSD').token;
        } catch {
          /* optional */
        }
        P.fb_api_caller_class = 'RelayModern';
        P.fb_api_req_friendly_name = o.name;
        P.variables = o.variables;
        P.server_timestamps = 'true';
        P.doc_id = o.docId;
        const h: Record<string, string> = { ...o.headers, 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': o.name };
        if (P.lsd) h['x-fb-lsd'] = P.lsd;
        const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        if (csrf) h['x-csrftoken'] = decodeURIComponent(csrf[1]!);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), o.timeout);
        try {
          const r = await fetch(o.url, { method: 'POST', headers: h, body: new URLSearchParams(P).toString(), credentials: 'include', signal: ctl.signal });
          let text = await r.text();
          if (text.startsWith('for (;;);')) text = text.slice(9);
          return { status: r.status, text: text.length > 16_000_000 ? null : text, finalPath: new URL(r.url).pathname };
        } catch (e: any) {
          return { status: 0, text: null, finalPath: '', error: String(e?.name ?? 'error') };
        } finally {
          clearTimeout(timer);
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { url: `${this.origin}/api/graphql`, name, docId, variables: JSON.stringify(variables), headers, timeout: timeoutMs },
    );
    const r = await withTimeout(run, timeoutMs + 5_000);
    if (!r) throw new IgRequestError('timeout', 'Instagram did not answer in time.');
    if (r.finalPath.startsWith('/accounts/login') || r.finalPath.startsWith('/challenge')) throw new IgRequestError('login', 'Instagram is logged out.');
    if (r.status === 0) throw new IgRequestError(r.error === 'AbortError' ? 'timeout' : 'network', 'Instagram could not be reached.');
    if (r.status === 401) throw new IgRequestError('login', 'Instagram is logged out.');
    if (r.status >= 400) throw new IgRequestError(`http_${r.status}`, `Instagram answered ${r.status}.`);
    if (r.text === null) throw new IgRequestError('graphql', 'Answer too large.');
    try {
      return parseGraphQL<T>(r.text);
    } catch (e) {
      if (e instanceof IgRequestError && e.code === 'graphql') throw new IgRequestError('graphql', `${name}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Calls one of Instagram Web's own REST endpoints (`/api/v1/…`) from inside the page, as the website does (same
   * cookies, CSRF token and app id). [form]: POST body (form-encoded). Returns the parsed JSON (exact big integers).
   */
  async rest<T = unknown>(method: 'GET' | 'POST', path: string, form: Record<string, string> | null = null, timeoutMs = 30_000): Promise<T> {
    if (!/^\/api\/v1\/[A-Za-z0-9_\-/.]+(\?[^#]*)?$/.test(path)) throw new IgRequestError('rest', 'bad path');
    const headers: Record<string, string> = { 'x-ig-app-id': DEFAULT_APP_ID, ...Object.fromEntries(this.headers), 'x-requested-with': 'XMLHttpRequest' };
    const run = this.page.evaluate(
      async (o: { url: string; method: string; form: Record<string, string> | null; headers: Record<string, string>; timeout: number }) => {
        const h: Record<string, string> = { ...o.headers };
        const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        if (csrf) h['x-csrftoken'] = decodeURIComponent(csrf[1]!);
        if (o.form) h['content-type'] = 'application/x-www-form-urlencoded';
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), o.timeout);
        try {
          const r = await fetch(o.url, { method: o.method, headers: h, body: o.form ? new URLSearchParams(o.form).toString() : undefined, credentials: 'include', signal: ctl.signal });
          const text = await r.text();
          return { status: r.status, text: text.length > 16_000_000 ? null : text, finalPath: new URL(r.url).pathname, json: (r.headers.get('content-type') ?? '').includes('json') };
        } catch (e) {
          return { status: 0, text: null, finalPath: '', json: false, error: String((e as { name?: string })?.name ?? 'error') };
        } finally {
          clearTimeout(timer);
        }
      },
      { url: `${this.origin}${path}`, method, form, headers, timeout: timeoutMs },
    );
    const r = await withTimeout(run, timeoutMs + 5_000);
    if (!r) throw new IgRequestError('timeout', 'Instagram did not answer in time.');
    if (r.finalPath.startsWith('/accounts/login') || r.finalPath.startsWith('/challenge')) throw new IgRequestError('login', 'Instagram is logged out.');
    if (r.status === 0) throw new IgRequestError(r.error === 'AbortError' ? 'timeout' : 'network', 'Instagram could not be reached.');
    if (r.status === 401 || (r.status === 403 && (r.text ?? '').includes('login_required'))) throw new IgRequestError('login', 'Instagram is logged out.');
    if (r.status === 429) throw new IgRequestError('http_429', 'Instagram is rate limiting. Try again later.');
    if (r.status >= 400 || r.text === null || !r.json) throw new IgRequestError(`http_${r.status}`, `Instagram answered ${r.status}.`);
    try {
      return parseJsonExact(r.text.replace(/^for \(;;\);/, '')) as T;
    } catch {
      throw new IgRequestError('rest', 'Instagram sent an unreadable answer.');
    }
  }

  /* ------------------------------------------------------------- download */

  readonly downloader: Downloader = {
    fetch: async (url, maxBytes, sink) => this.loadResource(url, maxBytes, sink),
  };

  private async mainFrameId(cdp: CDPSession): Promise<string> {
    if (this.frameId) return this.frameId;
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    this.frameId = tree.frameTree.frame.id;
    return this.frameId;
  }

  private async loadResource(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome> {
    const cdp = this.cdp;
    if (!cdp) return { status: 'error', reason: 'detached' };
    let frameId: string;
    try {
      frameId = await this.mainFrameId(cdp);
    } catch {
      this.frameId = null;
      return { status: 'error', reason: 'no_frame' };
    }
    const res = (await withTimeout(
      cdp.send('Network.loadNetworkResource', { frameId, url, options: { disableCache: false, includeCredentials: false } }),
      60_000,
    )) as { resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> } } | null;
    if (!res) return { status: 'error', reason: 'timeout' };
    const rsc = res.resource;
    if (!rsc.success || !rsc.stream) {
      if (rsc.stream) await cdp.send('IO.close', { handle: rsc.stream }).catch(() => undefined);
      return rsc.httpStatusCode ? { status: 'http', code: rsc.httpStatusCode } : { status: 'error', reason: (rsc.netErrorName ?? 'net_error').slice(0, 40) };
    }
    const header = (n: string) => {
      for (const [k, v] of Object.entries(rsc.headers ?? {})) if (k.toLowerCase() === n) return v;
      return null;
    };
    const declared = Number(header('content-length') ?? NaN);
    const handle = rsc.stream;
    try {
      if (Number.isFinite(declared) && declared > maxBytes) return { status: 'too_large' };
      let total = 0;
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        if (Date.now() > deadline) return { status: 'error', reason: 'timeout' };
        const chunk = (await withTimeout(cdp.send('IO.read', { handle, size: 1 << 20 }), 60_000)) as { data: string; base64Encoded?: boolean; eof: boolean } | null;
        if (!chunk) return { status: 'error', reason: 'timeout' };
        const b = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        total += b.length;
        if (total > maxBytes) return { status: 'too_large' };
        if (b.length) await sink(b);
        if (chunk.eof) break;
      }
      return { status: 'ok', mime: header('content-type'), size: total };
    } finally {
      await cdp.send('IO.close', { handle }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- state */

  /** Instagram's login cookies: the account id when logged in (cookie values are never logged). */
  async loggedInUserId(): Promise<string | null> {
    const cdp = this.cdp;
    if (!cdp) return null;
    const r = (await withTimeout(cdp.send('Network.getCookies', { urls: [this.origin] }), 10_000)) as { cookies: { name: string; value: string }[] } | null;
    if (!r) return null;
    const session = r.cookies.find((c) => c.name === 'sessionid' && c.value.length > 10);
    const user = r.cookies.find((c) => c.name === 'ds_user_id' && /^\d{1,24}$/.test(c.value));
    return session && user ? user.value : null;
  }
}

/** Instagram answers `{data, errors?}` — sometimes several JSON objects on separate lines (deferred parts). */
export function parseGraphQL<T>(text: string): T {
  const objs: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      objs.push(parseJsonExact(t) as Record<string, unknown>);
    } catch {
      // Say what came instead (size and the first few characters, e.g. an HTML page), never more of it.
      if (objs.length === 0) throw new IgRequestError('graphql', `Instagram sent an unreadable answer (${text.length} bytes, starts ${JSON.stringify(t.slice(0, 12).replace(/[^\x20-\x7e]/g, '?'))}).`);
    }
  }
  const first = objs[0];
  if (!first) throw new IgRequestError('graphql', 'Instagram sent an empty answer.');
  if (typeof first.error === 'number') {
    // 1357001: not logged in; 1357004: page needs a reload (new web build)
    if (first.error === 1357001) throw new IgRequestError('login', 'Instagram is logged out.');
    throw new IgRequestError(first.error === 1357004 ? 'reload' : 'graphql', `Instagram error ${first.error}.`);
  }
  const data = first.data as Record<string, unknown> | null | undefined;
  if (!data) {
    const errs = Array.isArray(first.errors) ? (first.errors as { message?: unknown; code?: unknown }[]) : [];
    const msg = errs.map((e) => (typeof e.message === 'string' ? e.message : '')).find((m) => m) ?? 'no data';
    throw new IgRequestError('graphql', msg.slice(0, 200));
  }
  // Deferred parts carry `{data, path}`: merge them into the main data at their path.
  for (const extra of objs.slice(1)) {
    const path = Array.isArray(extra.path) ? (extra.path as (string | number)[]) : null;
    if (!path || !extra.data || typeof extra.data !== 'object') continue;
    let node: unknown = data;
    for (const k of path) node = node && typeof node === 'object' ? (node as Record<string | number, unknown>)[k] : undefined;
    if (node && typeof node === 'object') Object.assign(node, extra.data);
  }
  return data as T;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
