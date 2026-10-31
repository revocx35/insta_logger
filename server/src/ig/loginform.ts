import type { CdpTarget } from './chromium.js';
import type { LoginLayout, Rect } from './humaninput.js';
import { BrowserCdp, type TabInfo } from './loginwatch.js';

/*
 * Where the login form is on the screen, for the automatic login (ig/autologin.ts). One short look and gone: attach to
 * the tab, read the DOM tree, the boxes of the fields and a hit test of each, detach. Only the DOM and Page domains'
 * read commands are used — no Runtime, no script in the page, no `*.enable`, no Network/Fetch — and the typing
 * afterwards comes in through VNC with nothing attached (see loginwatch.ts for why the login page is left alone).
 * The browser runs in kiosk mode at (0,0) with a device scale of 1, so CSS viewport pixels are screen pixels.
 */

export interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
}

export interface LoginFields {
  username: DomNode | null;
  password: DomNode;
  submit: DomNode | null;
}

function attr(n: DomNode, name: string): string | null {
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i]!.toLowerCase() === name) return a[i + 1]!;
  return null;
}

function textOf(n: DomNode): string {
  if (n.nodeType === 3) return n.nodeValue ?? '';
  return (n.children ?? []).map(textOf).join('');
}

/** Elements in document order (no frames, no shadow roots). */
function walk(root: DomNode, out: DomNode[] = []): DomNode[] {
  if (root.nodeType === 1) out.push(root);
  for (const c of root.children ?? []) walk(c, out);
  return out;
}

const TEXTLIKE = new Set(['', 'text', 'email', 'tel']);

/**
 * The login fields in a DOM tree: the first password input, the text field before it (username, email or phone —
 * Instagram has named it `username` and `email`), and the submit button after it ("Log in").
 */
export function pickLoginFields(root: DomNode): LoginFields | null {
  const els = walk(root);
  const usable = (n: DomNode) => attr(n, 'disabled') === null && attr(n, 'aria-hidden') !== 'true';
  const pi = els.findIndex((n) => n.nodeName === 'INPUT' && (attr(n, 'type') ?? '').toLowerCase() === 'password' && usable(n));
  if (pi < 0) return null;
  let username: DomNode | null = null;
  for (let i = pi - 1; i >= 0; i--) {
    const n = els[i]!;
    if (n.nodeName === 'INPUT' && TEXTLIKE.has((attr(n, 'type') ?? '').toLowerCase()) && usable(n)) {
      username = n;
      break;
    }
  }
  let submit: DomNode | null = null;
  for (const n of els.slice(pi + 1)) {
    const isButton = n.nodeName === 'BUTTON' || attr(n, 'role') === 'button' || (n.nodeName === 'INPUT' && attr(n, 'type') === 'submit');
    if (!isButton || !usable(n)) continue;
    const label = (n.nodeName === 'INPUT' ? attr(n, 'value') ?? '' : textOf(n)).trim();
    if ((n.nodeName === 'BUTTON' && attr(n, 'type') === 'submit') || /^(log ?in|giriş yap)$/i.test(label)) {
      submit = n;
      break;
    }
  }
  return { username, password: els[pi]!, submit };
}

/** The bounding box of a content quad ([x1,y1, x2,y2, x3,y3, x4,y4]). */
export function quadRect(q: number[]): Rect {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Parents by backend node id (for the hit test). */
function parents(root: DomNode): Map<number, number> {
  const m = new Map<number, number>();
  const go = (n: DomNode) => {
    for (const c of n.children ?? []) {
      m.set(c.backendNodeId, n.backendNodeId);
      go(c);
    }
  };
  go(root);
  return m;
}

/** The closest <form> around [n] (or the third ancestor): what a click on the field may legitimately land in. */
function scope(n: DomNode, up: Map<number, number>, byId: Map<number, DomNode>): number {
  let cur = n.backendNodeId;
  let fallback = cur;
  for (let i = 0; i < 12; i++) {
    const p = up.get(cur);
    if (p === undefined) break;
    cur = p;
    if (i === 2) fallback = cur;
    if (byId.get(cur)?.nodeName === 'FORM') return cur;
  }
  return fallback;
}

export function isInside(node: number, ancestor: number, up: Map<number, number>): boolean {
  for (let cur: number | undefined = node, i = 0; cur !== undefined && i < 64; cur = up.get(cur), i++) if (cur === ancestor) return true;
  return false;
}

export type FormLook = { ok: true; layout: LoginLayout } | { ok: false; reason: 'no_form' | 'hidden' | 'covered' };

/** Reads the login form's layout from the tab (attached only for these read commands). */
export async function readLoginForm(target: CdpTarget, tab: TabInfo): Promise<FormLook> {
  const cdp = await BrowserCdp.open(target);
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab.id, flatten: true });
    try {
      const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: false }, sessionId);
      const fields = pickLoginFields(root);
      if (!fields) return { ok: false, reason: 'no_form' };
      const metrics = await cdp.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sessionId);
      const vw = metrics.cssLayoutViewport.clientWidth;
      const vh = metrics.cssLayoutViewport.clientHeight;
      const up = parents(root);
      const byId = new Map(walk(root).map((n) => [n.backendNodeId, n]));
      const box = async (n: DomNode | null): Promise<Rect | null | 'hidden' | 'covered'> => {
        if (!n) return null;
        const { quads } = await cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: n.backendNodeId }, sessionId).catch(() => ({ quads: [] }));
        if (!quads[0]) return 'hidden';
        const r = quadRect(quads[0]);
        if (r.width < 8 || r.height < 8 || r.x < 0 || r.y < 0 || r.x + r.width > vw || r.y + r.height > vh) return 'hidden';
        const hit = await cdp
          .send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), includeUserAgentShadowDOM: false }, sessionId)
          .catch(() => null);
        if (!hit || !isInside(hit.backendNodeId, scope(n, up, byId), up)) return 'covered';
        return r;
      };
      const password = await box(fields.password);
      const username = await box(fields.username);
      const submit = await box(fields.submit);
      for (const r of [password, username]) if (r === 'hidden' || r === 'covered') return { ok: false, reason: r };
      return {
        ok: true,
        layout: {
          screen: { width: vw, height: vh },
          password: password as Rect,
          username: username as Rect | null,
          submit: submit === 'hidden' || submit === 'covered' ? null : submit,
        },
      };
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  } finally {
    cdp.close();
  }
}
