import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { StoryAuthor, StoryItem, StoryStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner, Wordmark } from '../components/ui';
import { formatAgo } from '../lib/format';
import { useAppState } from '../state/AppState';

const when = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Logged stories of the accounts the owner follows (story logging in Settings). */
export function StoriesPage() {
  const { ig } = useAppState();
  const [status, setStatus] = useState<StoryStatus | null>(null);
  const [authors, setAuthors] = useState<StoryAuthor[] | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [items, setItems] = useState<StoryItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async (u: string | null, before: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.stories(u, before);
      setItems((old) => (before ? [...old, ...page.items] : page.items));
      setNext(page.nextBefore);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.storyStatus(), api.storyAuthors()]);
      setStatus(s);
      setAuthors(a);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void load(user, null);
  }, [user, load]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await api.storyCheck());
      await refresh();
      await load(user, null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const connected = ig?.state === 'ready' || ig?.state === 'syncing';
  return (
    <div className="page stories-page">
      <header className="page-head row between wrap">
        <div>
          <h1>Stories</h1>
          <p className="muted small">
            {status?.enabled
              ? `Accounts you follow · kept ${status.retentionDays} days · ${status.stories} saved`
              : 'Story logging is off.'}
            {status?.enabled && status.lastCheckAt ? ` · last check ${when(status.lastCheckAt)}${status.lastResult ? ` (${status.lastResult})` : ''}` : ''}
          </p>
        </div>
        <div className="row gap">
          {status?.enabled ? (
            <button className="btn" onClick={() => void check()} disabled={checking || !connected} title={connected ? 'Look for new stories now' : 'Instagram is not connected'}>
              {checking ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Check now
            </button>
          ) : (
            <Link className="btn primary" to="/settings#logging">
              Turn on in Settings
            </Link>
          )}
        </div>
      </header>
      <ErrorNote error={error} />
      {authors && authors.length ? (
        <div className="story-authors" role="list">
          <button className={user === null ? 'story-author on' : 'story-author'} onClick={() => setUser(null)} role="listitem">
            <span className="story-ring all">
              <span className="story-all">
                <Icon name="stories" size={28} />
              </span>
            </span>
            <span className="story-author-name">All</span>
          </button>
          {authors.map((a) => (
            <button key={a.id} className={user === a.id ? 'story-author on' : 'story-author'} onClick={() => setUser(a.id)} role="listitem" title={a.name ?? undefined}>
              <span className="story-ring">
                <Avatar id={a.id} name={a.username ?? a.id} url={a.avatarUrl} size={58} />
              </span>
              <span className="story-author-name">{a.username ?? a.id}</span>
              <span className="story-count">{a.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!loading && !items.length ? (
        <EmptyState icon="stories" title="No stories yet">
          {status?.enabled ? 'New stories of the accounts you follow appear here after the next check.' : 'Turn on story logging in Settings → Logging.'}
        </EmptyState>
      ) : null}
      <div className="story-grid">
        {items.map((s, i) => (
          <button key={s.id} className="story-tile" onClick={() => setOpen(i)} aria-label={`Story by ${s.username ?? s.userId}`}>
            {s.url ? (
              s.type === 'video' ? (
                <video src={`${s.url}#t=0.1`} muted preload="metadata" playsInline />
              ) : (
                <img src={s.url} alt="" loading="lazy" decoding="async" />
              )
            ) : (
              <span className="story-missing">{s.status === 'too_large' ? 'Too large' : s.status === 'pending' ? 'Downloading…' : 'Not saved'}</span>
            )}
            <span className="story-date" aria-hidden="true">
              <b>{new Date(s.takenAt).getDate()}</b>
              <small>{new Date(s.takenAt).toLocaleDateString(undefined, { month: 'short' })}</small>
            </span>
            {s.type === 'video' ? <Icon name="reels" size={18} className="story-badge" /> : null}
            <span className="story-meta">
              <b>{s.username ?? s.userId}</b>
              <small>{formatAgo(s.takenAt)}</small>
            </span>
          </button>
        ))}
      </div>
      {loading ? <Spinner /> : null}
      {!loading && next ? (
        <button className="btn ghost" onClick={() => void load(user, next)}>
          Older stories
        </button>
      ) : null}
      {open !== null && items[open] ? <StoryViewer items={items} index={open} avatarOf={(id) => authors?.find((a) => a.id === id)?.avatarUrl ?? null} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** How long a photo story stays before moving on (Instagram uses about 5 s). */
const PHOTO_MS = 5000;

function StoryViewer(props: { items: StoryItem[]; index: number; avatarOf: (userId: string) => string | null; onIndex: (i: number) => void; onClose: () => void }) {
  const { items, index, avatarOf, onIndex, onClose } = props;
  const s = items[index]!;
  const prev = index > 0 ? () => onIndex(index - 1) : null;
  const next = index < items.length - 1 ? () => onIndex(index + 1) : null;
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  // The bars at the top cover this author's run of stories around the current one, like Instagram.
  let first = index;
  while (first > 0 && items[first - 1]!.userId === s.userId) first--;
  let last = index;
  while (last < items.length - 1 && items[last + 1]!.userId === s.userId) last++;

  useEffect(() => setProgress(0), [index]);
  const advance = useRef<() => void>(() => undefined);
  advance.current = () => (next ? next() : onClose());
  // Photos advance on a timer; videos report their own progress and advance when they end.
  useEffect(() => {
    if (paused || !s.url || s.type === 'video') return;
    const step = 50;
    const t = window.setInterval(() => {
      setProgress((p) => {
        const n = p + step / PHOTO_MS;
        if (n >= 1) {
          window.clearInterval(t);
          window.setTimeout(() => advance.current(), 0);
          return 1;
        }
        return n;
      });
    }, step);
    return () => window.clearInterval(t);
  }, [index, paused, s.url, s.type]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, index]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev?.();
      else if (e.key === 'ArrowRight') next?.();
      else if (e.key === ' ') setPaused((p) => !p);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [prev, next, onClose]);
  return (
    <div className="story-viewer" role="dialog" aria-label="Story" onClick={onClose}>
      <span className="story-viewer-brand">
        <Wordmark />
      </span>
      <button className="story-close" onClick={onClose} aria-label="Close">
        <Icon name="close" size={28} />
      </button>
      <button className={prev ? 'story-nav left' : 'story-nav left gone'} onClick={(e) => (e.stopPropagation(), prev?.())} aria-label="Previous story" disabled={!prev}>
        <Icon name="back" size={16} />
      </button>
      <div className="story-stage" onClick={(e) => e.stopPropagation()}>
        <div className="story-bars" aria-hidden="true">
          {items.slice(first, last + 1).map((it, i) => (
            <span key={it.id} className="story-bar">
              <span style={{ width: `${first + i < index ? 100 : first + i > index ? 0 : Math.round(progress * 100)}%` }} />
            </span>
          ))}
        </div>
        <header className="story-head">
          <Avatar id={s.userId} name={s.username ?? s.userId} url={avatarOf(s.userId)} size={32} />
          <b>{s.username ?? s.userId}</b>
          <span title={when(s.takenAt)}>{formatAgo(s.takenAt)}</span>
          <span className="story-spacer" />
          {s.type === 'video' ? (
            <button className="story-ctl" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Sound on' : 'Sound off'}>
              <Icon name={muted ? 'mute' : 'volume'} size={22} />
            </button>
          ) : null}
          <button className="story-ctl" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
            <Icon name={paused ? 'play' : 'pause'} size={20} />
          </button>
        </header>
        {s.url ? (
          s.type === 'video' ? (
            <video
              key={s.id}
              ref={video}
              src={s.url}
              autoPlay
              muted={muted}
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration) setProgress(v.currentTime / v.duration);
              }}
              onEnded={() => (next ? next() : onClose())}
            />
          ) : (
            <img key={s.id} src={s.url} alt="" />
          )
        ) : (
          <p className="story-missing">This story was not saved.</p>
        )}
        {/* Tap the left or right side to go back or on, like Instagram. */}
        <button className="story-tap left" onClick={() => prev?.()} aria-label="Previous story" tabIndex={-1} />
        <button className="story-tap right" onClick={() => (next ? next() : onClose())} aria-label="Next story" tabIndex={-1} />
      </div>
      <button className={next ? 'story-nav right' : 'story-nav right gone'} onClick={(e) => (e.stopPropagation(), next?.())} aria-label="Next story" disabled={!next}>
        <Icon name="back" size={16} className="flip" />
      </button>
    </div>
  );
}
