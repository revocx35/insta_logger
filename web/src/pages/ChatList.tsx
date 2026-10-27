import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ChatSummary } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { useServerEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { formatAgo } from '../lib/format';
import { useAppState } from '../state/AppState';

type Filter = 'all' | 'groups' | 'deleted' | 'requests';

function norm(s: string) {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function ChatList({ activeId }: { activeId: string | null }) {
  const navigate = useNavigate();
  const { ig } = useAppState();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setChats(await api.chats());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  useServerEvents((ev) => {
    if (ev.type === 'message' || ev.type === 'chat_update' || (ev.type === 'message_update' && ev.reason === 'deleted')) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), 600);
    }
  });

  const visible = useMemo(() => {
    if (!chats) return [];
    const q = norm(query.trim());
    return chats.filter((c) => {
      // Like Instagram: message requests and other folders only show under "Requests" (the unsent filter shows everything).
      if (filter === 'requests') {
        if (!c.folder) return false;
      } else if (filter !== 'deleted' && c.folder) return false;
      if (filter === 'groups' && c.kind !== 'group') return false;
      if (filter === 'deleted' && c.deletedCount === 0) return false;
      if (q && !norm(c.name).includes(q) && !norm(c.username ?? '').includes(q)) return false;
      return true;
    });
  }, [chats, query, filter]);

  const searchMessages = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  };

  return (
    <section className="chat-list" aria-label="Chats">
      <header className="pane-head">
        <h2>{ig?.me?.username ?? 'Messages'}</h2>
        <Link className="icon-btn" to="/search" aria-label="Search messages" title="Search messages">
          <Icon name="edit" size={24} />
        </Link>
      </header>
      <form className="search-box" onSubmit={searchMessages} role="search">
        <Icon name="search" size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats; Enter searches messages" title="Enter searches the messages" />
        {query ? (
          <button type="button" className="icon-btn small" onClick={() => setQuery('')} aria-label="Clear">
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </form>
      <div className="list-head">
        <b>Messages</b>
        <button className={filter === 'requests' ? 'link-btn active' : 'link-btn'} onClick={() => setFilter(filter === 'requests' ? 'all' : 'requests')}>
          Requests
        </button>
      </div>
      <div className="chips">
        {(['all', 'groups', 'deleted'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
            {f === 'all' ? 'Primary' : f === 'groups' ? 'Groups' : 'Has unsent'}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="chat-items">
        {!chats ? (
          <div className="center pad">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon="chats" title={chats.length ? 'No matching chats' : 'No chats logged yet'}>
            {chats.length ? null : 'Chats appear here as soon as Instagram is connected and messages arrive.'}
          </EmptyState>
        ) : (
          visible.map((c) => (
            <button key={c.id} className={c.id === activeId ? 'chat-item active' : 'chat-item'} onClick={() => navigate(`/chat/${encodeURIComponent(c.id)}`)}>
              <Avatar id={c.id} name={c.name} url={c.avatarUrl} kind={c.kind} size={56} />
              <span className="chat-item-body">
                <span className="chat-name">{c.name}</span>
                <span className="chat-item-bottom">
                  <span className={c.lastMessage?.deleted ? 'chat-preview deleted' : 'chat-preview'}>
                    {c.lastMessage?.deleted ? <Icon name="ban" size={13} /> : null}
                    <span className="chat-preview-text">
                      {c.lastMessage ? (
                        <>
                          {c.kind === 'group' && c.lastMessage.senderName ? `${c.lastMessage.senderName}: ` : c.lastMessage.fromMe ? 'You: ' : null}
                          {c.lastMessage.text ?? ''}
                        </>
                      ) : (
                        'No messages logged'
                      )}
                    </span>
                    {c.lastTs ? <span className="chat-time" title={new Date(c.lastTs).toLocaleString()}> · {formatAgo(c.lastTs)}</span> : null}
                  </span>
                </span>
              </span>
              <span className="chat-badges">
                {c.pinned ? <Icon name="pushpin" size={14} title="Pinned" /> : null}
                {c.muted ? <Icon name="mute" size={14} title="Muted" /> : null}
                {c.removed ? <span className="badge gray" title="Deleted on Instagram, kept in the log">removed</span> : null}
                {c.deletedCount > 0 ? (
                  <span className="badge red" title={`${c.deletedCount} unsent message(s) preserved`}>
                    {c.deletedCount}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
