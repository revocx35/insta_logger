import { Fragment } from 'react';

/*
 * Instagram message text → React elements. Instagram has no inline formatting, so this only turns http(s)
 * links and @usernames into elements and keeps line breaks. It never produces HTML strings, so message content
 * can never inject markup.
 */

export type IgNode = { t: 'text'; v: string } | { t: 'link'; href: string; v: string } | { t: 'mention'; v: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;
const MENTION_RE = /(^|[^\w.])@([A-Za-z0-9._]{1,30})/g;

export function safeHref(raw: string): string | null {
  const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function mentions(text: string): IgNode[] {
  const out: IgNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index! + m[1]!.length;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    out.push({ t: 'mention', v: `@${m[2]}` });
    last = at + 1 + m[2]!.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Splits text into plain runs, links and @mentions (linear time). */
export function parseIgText(text: string): IgNode[] {
  const out: IgNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const href = safeHref(m[0]);
    if (!href) continue;
    if (m.index! > last) out.push(...mentions(text.slice(last, m.index!)));
    out.push({ t: 'link', href, v: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...mentions(text.slice(last)));
  return out.filter((n) => n.t !== 'text' || n.v.length > 0);
}

/** A message made only of 1–3 emoji is shown large, like Instagram does. */
export function jumboEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  return /^(?:\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}️])*\s*){1,3}$/u.test(t);
}

export function IgText({ text }: { text: string }) {
  const nodes = parseIgText(text);
  return (
    <span className={jumboEmoji(text) ? 'ig-text jumbo' : 'ig-text'}>
      {nodes.map((n, i) =>
        n.t === 'link' ? (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {n.v}
          </a>
        ) : n.t === 'mention' ? (
          <span key={i} className="mention">
            {n.v}
          </span>
        ) : (
          <Fragment key={i}>{n.v}</Fragment>
        ),
      )}
    </span>
  );
}
