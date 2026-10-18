import { memo, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { Message, MessageEdit, MessageType } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { colorFor, dayKey, formatDateTime, formatTime } from '../lib/format';
import { IgText, safeHref } from '../lib/igText';
import { Icon } from './Icon';
import { MessageMedia } from './MessageMedia';
import { ErrorNote, Modal, Spinner } from './ui';

const QUOTE_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Photo',
  video: '🎥 Video',
  gif: 'GIF',
  voice: '🎤 Voice message',
  sticker: 'Sticker',
  share: '↗ Shared post',
  music: '🎵 Music',
  view_once: 'View-once media',
};

function Seen({ ack }: { ack: number | null }) {
  if (ack === null || ack < 1) return null;
  return ack >= 3 ? <span className="seen">Seen</span> : <Icon name="check" size={14} className="tick" title="Sent" />;
}

function EditHistory({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const [edits, setEdits] = useState<MessageEdit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.edits(msg.id).then(setEdits, (e) => setError(errorMessage(e)));
  }, [msg.id]);
  return (
    <Modal title="Edit history" onClose={onClose}>
      <ErrorNote error={error} />
      {!edits && !error ? <Spinner /> : null}
      <ol className="edit-list">
        {(edits ?? []).map((e, i) => (
          <li key={i}>
            <div className="muted small">Earlier version · captured {formatDateTime(e.capturedAt)}</div>
            <div className="edit-body">{e.body ? <IgText text={e.body} /> : <i className="muted">(no text)</i>}</div>
          </li>
        ))}
        <li>
          <div className="muted small">Current version{msg.editedAt ? ` · edited ${formatDateTime(msg.editedAt)}` : ''}</div>
          <div className="edit-body">{msg.text ? <IgText text={msg.text} /> : <i className="muted">(no text)</i>}</div>
        </li>
      </ol>
      {edits && edits.length === 0 ? <p className="muted small">The previous text was not captured (the edit happened before this message was logged).</p> : null}
    </Modal>
  );
}

/** A shared post / reel / story / profile / link: Instagram's card, with a link out (never fetched by the server). */
function ShareCard({ msg }: { msg: Message }) {
  const s = msg.share;
  if (!s) return null;
  const href = s.url ? safeHref(s.url) : null;
  const body = (
    <>
      {s.eyebrow ? <span className="share-eyebrow">{s.eyebrow}</span> : null}
      <span className="share-kind">
        <Icon name={s.kind === 'Link' ? 'link' : 'forward'} size={14} /> {s.kind ?? 'Shared'}
      </span>
      {s.title ? <b className="share-title">{s.title}</b> : null}
      {s.subtitle ? <span className="muted small">{s.subtitle}</span> : null}
      {s.caption ? <span className="share-caption">{s.caption}</span> : null}
    </>
  );
  return href ? (
    <a className="share-card" href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
      {body}
    </a>
  ) : (
    <div className="share-card">{body}</div>
  );
}

const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
/** Instagram's window for editing own messages (it enforces it too). */
const EDIT_WINDOW_MS = 15 * 60_000;

/** What the owner can do with a message (sending through the logged-in account). */
export interface MessageActions {
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onUnsend: (m: Message) => void;
}

function ActionMenu({ msg, actions }: { msg: Message; actions: MessageActions }) {
  const [open, setOpen] = useState(false);
  const [confirmUnsend, setConfirmUnsend] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setConfirmUnsend(false);
  }, [open]);
  const age = Date.now() - msg.ts;
  const mine = msg.reactions.find((r) => r.fromMe)?.emoji;
  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const realId = !/~\d+$/.test(msg.id);
  return (
    <div className={open ? 'msg-actions open' : 'msg-actions'} ref={ref}>
      <button className="icon-btn small" onClick={() => setOpen((v) => !v)} aria-label="Message actions" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          {realId ? (
            <div className="menu-reactions">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} role="menuitem" className={mine === e ? 'active' : ''} onClick={choose(() => actions.onReact(msg, mine === e ? '' : e))} aria-label={`React ${e}`}>
                  {e}
                </button>
              ))}
            </div>
          ) : null}
          <button role="menuitem" onClick={choose(() => actions.onReply(msg))}>
            <Icon name="reply" size={16} /> Reply
          </button>
          {msg.text ? (
            <button role="menuitem" onClick={choose(() => void navigator.clipboard?.writeText(msg.text ?? ''))}>
              <Icon name="file" size={16} /> Copy text
            </button>
          ) : null}
          {msg.fromMe && msg.type === 'text' && age < EDIT_WINDOW_MS ? (
            <button role="menuitem" onClick={choose(() => actions.onEdit(msg))}>
              <Icon name="edit" size={16} /> Edit
            </button>
          ) : null}
          {msg.fromMe && realId ? (
            confirmUnsend ? (
              <button role="menuitem" className="danger" onClick={choose(() => actions.onUnsend(msg))}>
                <Icon name="deleted" size={16} /> Yes, unsend for everyone
              </button>
            ) : (
              <button role="menuitem" className="danger" onClick={() => setConfirmUnsend(true)}>
                <Icon name="deleted" size={16} /> Unsend…
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface BubbleProps {
  msg: Message;
  isGroup: boolean;
  showSender: boolean;
  highlighted: boolean;
  onJump: (messageId: string) => void;
  /** Selection mode (select photos/videos to download together): set only while selecting. */
  selection?: { selected: boolean; onToggle: (messageId: string) => void };
  /** Message actions (reply, react, edit, unsend); not shown while selecting. */
  actions?: MessageActions;
}

/** Photos, videos and GIFs that have been downloaded can be selected for "Download ZIP". */
export function isSelectable(msg: Message): boolean {
  return msg.media?.status === 'downloaded' && !!msg.media.url && (msg.type === 'image' || msg.type === 'video' || msg.type === 'gif');
}

function deletedLabel(msg: Message): string {
  const when = dayKey(msg.deletedAt!) === dayKey(msg.ts) ? formatTime(msg.deletedAt!) : formatDateTime(msg.deletedAt!);
  return msg.deletedBy === 'missing' ? `Gone from Instagram · noticed ${when}` : `Unsent · ${when}`;
}

function BubbleImpl({ msg, isGroup, showSender, highlighted, onJump, selection, actions }: BubbleProps) {
  const [showEdits, setShowEdits] = useState(false);

  if (msg.type === 'system') {
    return (
      <div className="system-row" id={`m-${msg.id}`}>
        <span className={msg.deletedAt ? 'system-pill deleted' : 'system-pill'}>
          {msg.text ?? 'Chat update'} · {formatTime(msg.ts)}
        </span>
      </div>
    );
  }

  const deleted = msg.deletedAt !== null;
  const classes = ['bubble', msg.fromMe ? 'out' : 'in', deleted ? 'deleted' : '', highlighted ? 'highlight' : '', msg.type === 'sticker' && msg.media?.url ? 'sticker' : '']
    .filter(Boolean)
    .join(' ');

  const rowClass = [msg.fromMe ? 'msg-row out' : 'msg-row in', selection ? 'selectable' : '', selection?.selected ? 'selected' : ''].filter(Boolean).join(' ');
  // While selecting, the whole row is one checkbox: clicks never reach the photo/video inside (CSS turns off
  // their pointer events), so nothing opens or plays by accident.
  const selectProps = selection
    ? {
        role: 'checkbox',
        'aria-checked': selection.selected,
        'aria-label': msg.type === 'image' ? 'Select photo' : 'Select video',
        tabIndex: 0,
        onClick: () => selection.onToggle(msg.id),
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            selection.onToggle(msg.id);
          }
        },
      }
    : {};

  return (
    <div className={rowClass} id={`m-${msg.id}`} {...selectProps}>
      {selection ? (
        <span className="select-check" aria-hidden="true">
          {selection.selected ? <Icon name="check" size={16} /> : null}
        </span>
      ) : null}
      <div className={classes}>
        {actions && !selection && !deleted ? <ActionMenu msg={msg} actions={actions} /> : null}
        {deleted ? (
          <div className="deleted-banner" title={`${msg.deletedBy === 'missing' ? 'Noticed gone' : 'Unsent'} ${formatDateTime(msg.deletedAt!)}`}>
            <Icon name="ban" size={14} /> {deletedLabel(msg)} · logged copy
          </div>
        ) : null}
        {isGroup && !msg.fromMe && showSender ? (
          <div className="sender" style={{ color: colorFor(msg.senderId ?? msg.senderName ?? '') }}>
            {msg.senderName ?? 'Unknown'}
            {msg.senderUsername ? <span className="muted small"> @{msg.senderUsername}</span> : null}
          </div>
        ) : null}
        {msg.forwarded ? (
          <div className="forwarded">
            <Icon name="forward" size={14} /> Forwarded
          </div>
        ) : null}
        {msg.quoted ? (
          <button className="quote" onClick={() => msg.quoted?.id && onJump(msg.quoted.id)} disabled={!msg.quoted.id}>
            <span className="quote-sender">{msg.quoted.fromMe ? 'You' : msg.quoted.senderName ?? 'Unknown'}</span>
            <span className="quote-text">{msg.quoted.text ?? QUOTE_LABEL[msg.quoted.type] ?? 'Message'}</span>
          </button>
        ) : null}
        {msg.album ? <div className="muted small">{`${msg.album.index + 1} of ${msg.album.count}`}</div> : null}
        <MessageMedia msg={msg} />
        <ShareCard msg={msg} />
        {msg.music ? (
          <div className="music">
            <Icon name="music" size={18} /> <b>{msg.music.title ?? 'Song'}</b> {msg.music.artist ? <span className="muted">· {msg.music.artist}</span> : null}
          </div>
        ) : null}
        {msg.text ? (
          <div className="text">
            <IgText text={msg.text} />
          </div>
        ) : null}
        <div className="meta">
          {msg.expiresAt ? (
            <span title={`Disappears ${formatDateTime(msg.expiresAt)}`}>
              <Icon name="clock" size={12} />
            </span>
          ) : null}
          {msg.edited ? (
            <button className="link-btn edited" onClick={() => setShowEdits(true)} title="Show edit history">
              <Icon name="edit" size={12} /> Edited{msg.editCount > 1 ? ` ×${msg.editCount}` : ''}
            </button>
          ) : null}
          <span title={formatDateTime(msg.ts)}>{formatTime(msg.ts)}</span>
          {msg.fromMe ? <Seen ack={msg.ack} /> : null}
        </div>
      </div>
      {msg.reactions.length ? (
        <div className="reactions" title={msg.reactions.map((r) => `${r.senderName ?? r.senderId}: ${r.emoji}`).join('\n')}>
          {[...new Set(msg.reactions.map((r) => r.emoji))].slice(0, 4).join('')}
          {msg.reactions.length > 1 ? <span className="small"> {msg.reactions.length}</span> : null}
        </div>
      ) : null}
      {showEdits ? <EditHistory msg={msg} onClose={() => setShowEdits(false)} /> : null}
    </div>
  );
}

export const MessageBubble = memo(BubbleImpl);
