import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { StoryAuthor, StoryItem, StoryStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner } from '../components/ui';
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
          <h1>
            <Icon name="stories" /> Stories
          </h1>
          <p className="muted">
            {status?.enabled
              ? `Logging the stories of the accounts you follow · kept ${status.retentionDays} days · ${status.stories} saved`
              : 'Story logging is off.'}
            {status?.enabled && status.lastCheckAt ? ` · last check ${when(status.lastCheckAt)}${status.lastResult ? ` (${status.lastResult})` : ''}` : ''}
          </p>
        </div>
        <div className="row gap">
          {status?.enabled ? (
            <button className="btn ghost" onClick={() => void check()} disabled={checking || !connected} title={connected ? 'Look for new stories now' : 'Instagram is not connected'}>
              {checking ? <Spinner size={18} /> : <Icon name="refresh" size={18} />} Check now
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
              <Icon name="stories" size={26} />
            </span>
            <span className="story-author-name">All</span>
          </button>
          {authors.map((a) => (
            <button key={a.id} className={user === a.id ? 'story-author on' : 'story-author'} onClick={() => setUser(a.id)} role="listitem" title={a.name ?? undefined}>
              <span className="story-ring">
                <Avatar id={a.id} name={a.username ?? a.id} url={a.avatarUrl} size={56} />
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
            {s.type === 'video' ? <span className="story-badge">▶</span> : null}
            <span className="story-meta">
              <b>{s.username ?? s.userId}</b>
              <small>{when(s.takenAt)}</small>
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
      {open !== null && items[open] ? <StoryViewer items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function StoryViewer({ items, index, onIndex, onClose }: { items: StoryItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const s = items[index]!;
  const prev = index > 0 ? () => onIndex(index - 1) : null;
  const next = index < items.length - 1 ? () => onIndex(index + 1) : null;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev?.();
      else if (e.key === 'ArrowRight') next?.();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [prev, next, onClose]);
  return (
    <div className="story-viewer" role="dialog" aria-label="Story" onClick={onClose}>
      <div className="story-stage" onClick={(e) => e.stopPropagation()}>
        <header className="story-head">
          <b>{s.username ?? s.userId}</b>
          <span>{when(s.takenAt)}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {s.url ? (
          s.type === 'video' ? (
            <video key={s.id} src={s.url} autoPlay controls playsInline onEnded={() => next?.()} />
          ) : (
            <img key={s.id} src={s.url} alt="" />
          )
        ) : (
          <p className="muted">This story was not saved.</p>
        )}
        {prev ? (
          <button className="story-nav left" onClick={prev} aria-label="Previous story">
            ‹
          </button>
        ) : null}
        {next ? (
          <button className="story-nav right" onClick={next} aria-label="Next story">
            ›
          </button>
        ) : null}
      </div>
    </div>
  );
}
