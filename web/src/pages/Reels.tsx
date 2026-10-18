import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary, WebComment, WebPost } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { useAppState } from '../state/AppState';

/** How many of the next reels preload their video (like Instagram). */
const PRELOAD_AHEAD = 3;

/** Instagram's reels, played through the server; "Send" shares a reel's link into a chat. */
export function ReelsPage() {
  const { ig } = useAppState();
  const connected = ig?.state === 'ready' || ig?.state === 'syncing';
  const [reels, setReels] = useState<WebPost[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [sharing, setSharing] = useState<WebPost | null>(null);
  const [commenting, setCommenting] = useState<WebPost | null>(null);
  const busy = useRef(false);

  const load = useCallback(
    async (cursor: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await api.reels(cursor);
        setReels((old) => {
          const have = new Set(old.map((r) => r.id));
          return [...(cursor ? old : []), ...page.items.filter((r) => !have.has(r.id) || !cursor)];
        });
        setNext(page.next);
        setDone(!page.next);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (connected && !reels.length && !busy.current) void load(null);
  }, [connected, reels.length, load]);

  const scroller = useRef<HTMLDivElement>(null);
  const refresh = () => {
    scroller.current?.scrollTo({ top: 0 });
    setActive(0);
    setDone(false);
    void load(null);
  };

  // Near the end: fetch the next page.
  useEffect(() => {
    if (next && !done && active >= reels.length - 3) void load(next);
  }, [active, reels.length, next, done, load]);

  if (!connected) {
    return (
      <div className="page">
        <EmptyState icon="reels" title="Instagram is not connected">
          Reels play through the server's Instagram login. Log in on the Instagram screen first.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="reels-page">
      <button className="reels-refresh" onClick={refresh} disabled={loading} title="Load a fresh reels feed" aria-label="Refresh feed">
        {loading ? <Spinner size={18} /> : <Icon name="refresh" size={20} />}
      </button>
      <div className="reels-scroller" ref={scroller}>
        {reels.map((r, i) => (
          <Reel
            key={r.id}
            reel={r}
            index={i}
            near={i >= active - 1 && i <= active + PRELOAD_AHEAD}
            ahead={i > active && i <= active + PRELOAD_AHEAD}
            active={i === active}
            muted={muted}
            onVisible={setActive}
            onMute={() => setMuted((m) => !m)}
            onShare={() => setSharing(r)}
            onComments={() => setCommenting(r)}
          />
        ))}
        <div className="reels-end">
          {loading ? <Spinner /> : null}
          <ErrorNote error={error} />
          {error ? (
            <button className="btn" onClick={() => void load(reels.length ? next : null)}>
              Try again
            </button>
          ) : null}
          {done && reels.length && !loading ? <p className="muted">That's all for now.</p> : null}
        </div>
      </div>
      {sharing ? <ShareSheet reel={sharing} onClose={() => setSharing(null)} /> : null}
      {commenting ? <CommentsSheet reel={commenting} onClose={() => setCommenting(null)} /> : null}
    </div>
  );
}

function compact(n: number | null): string {
  if (n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function Reel(props: {
  reel: WebPost;
  index: number;
  near: boolean;
  /** One of the next reels: its video is preloaded so swiping to it starts at once. */
  ahead: boolean;
  active: boolean;
  muted: boolean;
  onVisible: (i: number) => void;
  onMute: () => void;
  onShare: () => void;
  onComments: () => void;
}) {
  const { reel, index, near, ahead, active, muted, onVisible, onMute, onShare, onComments } = props;
  const box = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [more, setMore] = useState(false);
  const [liked, setLiked] = useState(reel.liked);
  const [likes, setLikes] = useState(reel.likeCount);
  const [likeError, setLikeError] = useState(false);

  const like = async () => {
    const on = !liked;
    setLiked(on);
    setLikes((n) => (n === null ? n : n + (on ? 1 : -1)));
    setLikeError(false);
    try {
      await api.reelLike(reel.id, on);
    } catch {
      setLiked(!on);
      setLikes((n) => (n === null ? n : n + (on ? -1 : 1)));
      setLikeError(true);
    }
  };
  const clip = reel.media.find((m) => m.kind === 'video') ?? reel.media[0]!;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && onVisible(index), { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [index, onVisible]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (active) {
      v.currentTime = 0;
      setPaused(false);
      void v.play().catch(() => setPaused(true));
    } else v.pause();
  }, [active]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  };

  return (
    <section className="reel" ref={box} aria-label={`Reel by ${reel.user.username}`}>
      <div className="reel-stage">
        {near ? (
          <video
            ref={video}
            className="reel-video"
            src={clip.src}
            poster={clip.poster ?? undefined}
            loop
            playsInline
            muted={muted}
            preload={active || ahead ? 'auto' : 'metadata'}
            onClick={toggle}
            onDoubleClick={() => !liked && void like()}
          />
        ) : clip.poster ? (
          <img className="reel-video" src={clip.poster} alt="" loading="lazy" />
        ) : (
          <div className="reel-video" />
        )}
        {paused && active ? (
          <button className="reel-play" onClick={toggle} aria-label="Play">
            ▶
          </button>
        ) : null}
        <button className="reel-mute" onClick={onMute} aria-label={muted ? 'Sound on' : 'Sound off'}>
          <Icon name={muted ? 'mute' : 'volume'} size={18} />
        </button>
        <div className="reel-info">
          <div className="reel-author">
            <Avatar id={reel.user.id} name={reel.user.username} url={reel.user.avatar} size={32} />
            <b>{reel.user.username}</b>
            {reel.user.verified ? <Icon name="check" size={14} className="reel-verified" title="Verified" /> : null}
          </div>
          {reel.caption ? (
            <p className={more ? 'reel-caption open' : 'reel-caption'} onClick={() => setMore((m) => !m)}>
              {reel.caption}
            </p>
          ) : null}
        </div>
      </div>
      <div className="reel-actions">
        <button className={liked ? 'reel-action liked' : 'reel-action'} onClick={() => void like()} title={likeError ? 'Instagram did not accept that' : liked ? 'Unlike' : 'Like'} aria-pressed={liked}>
          <Icon name="heart" size={26} />
          <small>{likeError ? '!' : compact(likes)}</small>
        </button>
        <button className="reel-action" onClick={onComments} title="Comments">
          <Icon name="comment" size={26} />
          <small>{compact(reel.commentCount)}</small>
        </button>
        <button className="reel-action" onClick={onShare} title="Send to a chat" disabled={!reel.code}>
          <Icon name="send" size={26} />
          <small>Send</small>
        </button>
      </div>
    </section>
  );
}

function ShareSheet({ reel, onClose }: { reel: WebPost; onClose: () => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .chats()
      .then((c) => setChats(c.filter((x) => !x.removed)))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (chats ?? []).filter((c) => !t || c.name.toLowerCase().includes(t) || (c.username ?? '').toLowerCase().includes(t)).slice(0, 60);
  }, [chats, q]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const link = `https://www.instagram.com/reel/${reel.code}/`;
      for (const id of picked) {
        await api.sendText(id, link);
        if (note.trim()) await api.sendText(id, note.trim());
      }
      setSent(true);
      setTimeout(onClose, 900);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Send reel" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <b>Send to</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <input className="sheet-search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="sheet-list">
          {chats === null && !error ? <Spinner /> : null}
          {shown.map((c) => {
            const on = picked.includes(c.id);
            return (
              <button key={c.id} className={on ? 'sheet-chat on' : 'sheet-chat'} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}>
                <Avatar id={c.id} name={c.name} url={c.avatarUrl} kind={c.kind} size={44} />
                <span className="sheet-name">
                  {c.name}
                  {c.username && c.username !== c.name ? <small className="muted">{c.username}</small> : null}
                </span>
                <span className="sheet-check">{on ? <Icon name="check" size={16} /> : null}</span>
              </button>
            );
          })}
          {chats && !shown.length ? <p className="muted small">No chats found.</p> : null}
        </div>
        <ErrorNote error={error} />
        <footer className="sheet-foot">
          <input placeholder="Write a message…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          <button className="btn primary" disabled={!picked.length || sending || sent} onClick={() => void send()}>
            {sending ? <Spinner size={18} /> : sent ? 'Sent' : picked.length > 1 ? `Send separately (${picked.length})` : 'Send'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 7))}w`;
}

function CommentsSheet({ reel, onClose }: { reel: WebPost; onClose: () => void }) {
  const [items, setItems] = useState<WebComment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.reelComments(reel.id, cursor);
        setItems((old) => (cursor ? [...old, ...page.items.filter((c) => !old.some((o) => o.id === c.id))] : page.items));
        setNext(page.next);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [reel.id],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const [replyTo, setReplyTo] = useState<WebComment | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const startReply = (c: WebComment) => {
    setReplyTo(c);
    setText(`@${c.user.username} `);
    input.current?.focus();
  };

  const post = async () => {
    setPosting(true);
    setError(null);
    try {
      const parent = replyTo;
      const r = await api.reelComment(reel.id, text, parent?.id ?? null);
      const mine = r.comment;
      if (mine) {
        if (parent) setItems((old) => old.map((c) => (c.id === parent.id ? { ...c, replyCount: c.replyCount + 1, replies: [...c.replies, mine] } : c)));
        else setItems((old) => [mine, ...old]);
      }
      setText('');
      setReplyTo(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPosting(false);
    }
  };

  const line = (c: WebComment, reply: boolean) => (
    <div key={c.id} className={reply ? 'comment reply' : 'comment'}>
      <Avatar id={c.user.id} name={c.user.username} url={c.user.avatar} size={reply ? 24 : 32} />
      <div className="comment-body">
        <div>
          <b>{c.user.username}</b> <span className="comment-text">{c.text}</span>
        </div>
        <small className="muted">
          {ago(c.createdAt)}
          {c.likeCount ? ` · ${compact(c.likeCount)} likes` : ''}
          {' · '}
          <button className="link-btn" onClick={() => startReply(c)}>
            Reply
          </button>
        </small>
        {!reply && c.replies.length ? <div className="comment-replies">{c.replies.map((r) => line(r, true))}</div> : null}
        {!reply && c.replyCount > c.replies.length ? (
          <small className="muted">
            {c.replyCount - c.replies.length} more {c.replyCount - c.replies.length === 1 ? 'reply' : 'replies'} on Instagram
          </small>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Comments" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <b>Comments</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-list comments-list">
          {items.map((c) => line(c, false))}
          {loading ? <Spinner /> : null}
          {!loading && !items.length && !error ? <p className="muted small">No comments yet.</p> : null}
          {!loading && next ? (
            <button className="btn ghost" onClick={() => void load(next)}>
              More comments
            </button>
          ) : null}
        </div>
        <ErrorNote error={error} />
        {replyTo ? (
          <div className="replying">
            <span className="muted small">Replying to @{replyTo.user.username}</span>
            <button
              className="icon-btn small"
              aria-label="Cancel reply"
              onClick={() => {
                setReplyTo(null);
                setText('');
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : null}
        <form
          className="sheet-foot comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !posting) void post();
          }}
        >
          <input
            ref={input}
            placeholder={replyTo ? `Reply to @${replyTo.user.username}…` : 'Add a comment…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2200}
          />
          <button className="btn primary" disabled={!text.trim() || posting}>
            {posting ? <Spinner size={18} /> : 'Post'}
          </button>
        </form>
      </div>
    </div>
  );
}
