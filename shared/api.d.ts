/**
 * insta_logger HTTP API contract — shared by server (`server/`) and web UI (`web/`).
 * Type-only declaration file: never put runtime code here.
 * Timestamps are Unix epoch **milliseconds** unless stated otherwise.
 * See ARCHITECTURE.md §8 for the route table.
 */

/* ------------------------------------------------------------------ errors */

export interface ApiError {
  error: {
    /** Stable machine code, e.g. "unauthorized", "invalid_credentials", "rate_limited", "validation", "conflict", "not_found", "internal". */
    code: string;
    /** Human-readable, safe to show to the user. Never contains internals. */
    message: string;
    /** Seconds until retry is allowed (rate limit / lockout). */
    retryAfter?: number;
  };
}

/* ------------------------------------------------------------------- state */

export type IgState =
  | 'idle' //           no owner yet / client not started
  | 'starting' //       connecting to Chromium, loading Instagram
  | 'login' //          Instagram shows its login page: log in through the "Instagram" screen (VNC)
  | 'challenge' //      Instagram asks for a check (2FA code, "was this you?", consent): answer it on the Instagram screen
  | 'syncing' //        logged in, initial history import running
  | 'ready' //          logged in, inbox open and logging
  | 'error'; //         browser unreachable etc. (auto-retrying)

export interface IgStatus {
  state: IgState;
  /** Short safe description, e.g. "Chromium unreachable, retrying in 10s". */
  detail?: string;
  /** The logged-in account (only when logged in). */
  me?: { id: string; username: string | null; name: string | null };
  /** Initial sync / reconcile progress. */
  sync?: { phase: 'history' | 'reconcile'; chatsDone: number; chatsTotal: number } | null;
  /** Pending media downloads. */
  mediaQueue: number;
  /** When the last live update arrived from Instagram's message stream (null: none since start). */
  lastEventAt: number | null;
  since: number;
}

export interface AppState {
  hasOwner: boolean;
  authenticated: boolean;
  onboardingComplete: boolean;
  /** Present when authenticated: send as `X-CSRF-Token` on every non-GET request. */
  csrfToken?: string;
  username?: string;
  /** Whether TOTP two-factor authentication is enabled (authenticated only). */
  totpEnabled?: boolean;
  ig?: IgStatus;
}

/* -------------------------------------------------------------------- auth */

export interface SignupRequest { setupToken: string; username: string; password: string }
export interface SignupResponse { recoveryKey: string }

export interface LoginRequest { username: string; password: string; totp?: string }
/** On success: `{ ok: true }`. If TOTP is enabled and missing/invalid: `{ ok: false, needTotp: true }`. */
export interface LoginResponse { ok: boolean; needTotp?: boolean }

export interface RecoverRequest { username: string; recoveryKey: string; newPassword: string }
export interface RecoverResponse { recoveryKey: string }

export interface ChangePasswordRequest { currentPassword: string; newPassword: string }

export interface SessionInfo {
  id: string; // opaque, safe to expose (hash prefix), used for DELETE
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface TotpSetupResponse { secret: string; otpauthUrl: string }
export interface TotpEnableRequest { code: string; password: string }
export interface TotpDisableRequest { password: string; code: string }
export interface RotateRecoveryKeyRequest { password: string; totp?: string }
export interface RotateRecoveryKeyResponse { recoveryKey: string }

export interface VncCredentials { password: string }

/* -------------------------------------------------------------- chats etc. */

export type ChatKind = 'user' | 'group';

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  name: string; // decrypted display name (falls back to the username / id)
  /** The other person's Instagram username in one-to-one chats. */
  username: string | null;
  avatarUrl: string | null; // "/api/media/<id>" or null
  lastTs: number | null;
  lastMessage: MessagePreview | null;
  /** Message requests and other non-primary folders. */
  folder: string | null;
  pinned: boolean;
  muted: boolean;
  /** Chat was deleted on Instagram (or left) but is kept in the log. */
  removed: boolean;
  messageCount: number;
  deletedCount: number;
}

export interface MessagePreview {
  id: string;
  type: MessageType;
  fromMe: boolean;
  senderName: string | null;
  text: string | null; // body or caption, truncated to ~120 chars
  deleted: boolean;
  ts: number;
}

/**
 * text · image · video · gif (animated media) · voice (voice message / audio) · sticker ·
 * share (shared post, reel, story, profile or link; may carry a preview image) · music (music sticker) ·
 * system (group changes, calls, "liked a message" …) · view_once (view-once / replayable photo or video, never logged) ·
 * unknown (a content type insta_logger does not know yet; the raw type name is kept)
 */
export type MessageType = 'text' | 'image' | 'video' | 'gif' | 'voice' | 'sticker' | 'share' | 'music' | 'system' | 'view_once' | 'unknown';

/**
 * none: no media · pending: queued/downloading · downloaded: available at `url` · failed: download failed (retryable)
 * too_large: above the size cap (retryable after raising it) · skipped: history media not downloaded (setting)
 * view_once: view-once media, never logged · unavailable: Instagram no longer has it (expired/deleted before download)
 */
export type MediaStatus = 'none' | 'pending' | 'downloaded' | 'failed' | 'too_large' | 'skipped' | 'view_once' | 'unavailable';

export interface MediaInfo {
  status: MediaStatus;
  url: string | null; // "/api/media/<id>" when downloaded
  mime: string | null;
  filename: string | null;
  size: number | null; // bytes
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface QuotedSnapshot {
  id: string | null;
  senderName: string | null;
  fromMe: boolean;
  type: MessageType;
  text: string | null;
}

export interface Reaction {
  senderId: string;
  senderName: string | null;
  emoji: string;
  ts: number;
  /** The owner's own reaction. */
  fromMe?: boolean;
}

/** A shared post/reel/story/profile/link (Instagram's "XMA" attachments). */
export interface ShareInfo {
  /** e.g. "Reel", "Post", "Story", "Link" (Instagram's own header text when there is one). */
  kind: string | null;
  title: string | null;
  subtitle: string | null;
  /** Caption of the shared post (when Instagram sends it). */
  caption: string | null;
  /** Where it points (instagram.com post/reel/profile or an external link). Never fetched by the server. */
  url: string | null;
  /** Small text above a reply ("Replied to your story", "Mentioned you in their story"). */
  eyebrow: string | null;
}

export interface MusicInfo { title: string | null; artist: string | null }

export interface Message {
  id: string;
  chatId: string;
  senderId: string | null;
  senderName: string | null;
  /** The sender's Instagram username, when known. */
  senderUsername: string | null;
  fromMe: boolean;
  ts: number;
  type: MessageType;
  /** Body text / caption / rendered system text. null for pure media. */
  text: string | null;
  media: MediaInfo | null;
  quoted: QuotedSnapshot | null;
  share: ShareInfo | null;
  music: MusicInfo | null;
  mentions: { id: string; name: string | null }[];
  forwarded: boolean;
  /** Part of a message with several photos/videos: 0-based position and count. */
  album: { index: number; count: number } | null;
  /** Disappearing message: when Instagram removes it (null when it doesn't). */
  expiresAt: number | null;
  /** 1 sent · 3 seen by the other side (own messages only). */
  ack: number | null;
  reactions: Reaction[];
  edited: boolean;
  editedAt: number | null;
  editCount: number;
  /** Unsent by the sender (or removed by Instagram) — content above is the logged copy. */
  deletedAt: number | null;
  /** "sender" (unsent live) · "missing" (gone from Instagram, noticed later by a re-check). */
  deletedBy: string | null;
  source: 'live' | 'history';
  capturedAt: number;
}

export interface MessagePage {
  messages: Message[]; // ascending by ts within the page
  /** Pass as `before` to load older messages; null when no older messages exist. */
  nextBefore: string | null;
  /** For `around` pages: cursor for newer messages; null when at the newest message. */
  nextAfter?: string | null;
}

export interface MessageEdit { body: string | null; capturedAt: number }

export interface DeletedFeedItem { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface DeletedFeedPage { items: DeletedFeedItem[]; nextBefore: string | null }

/**
 * `GET /api/media-feed?after=&limit=`: messages whose media finished downloading after `after`, oldest first.
 * Without `after` (or with a cursor from before a data wipe) there are no items, only the current cursor.
 * Pass `cursor` as the next `after`; `more` means another page is ready right away.
 */
export interface MediaFeedItem { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface MediaFeedPage { items: MediaFeedItem[]; cursor: string; more: boolean }

export interface SearchHit { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface SearchResponse { hits: SearchHit[]; truncated: boolean }

/* ----------------------------------------------------------------- sending */

/** `POST /api/chats/:chatId/send`. The sent message arrives like any other (SSE `message`). */
export interface SendTextRequest { text: string; quotedId?: string | null }
/** The id of the sent message when Instagram reported it (null otherwise; it still appears through SSE). */
export interface SendResult { id: string | null }

/**
 * `POST /api/uploads` with the raw file as the body (`Content-Type: application/octet-stream`) and the file name in
 * `X-Filename` (percent-encoded). Kept in memory for 10 minutes until it is sent with `POST /api/chats/:chatId/send-media`.
 */
export interface UploadResponse { uploadId: string; size: number }
/** auto: photo/video/audio by type · voice: voice message */
export type SendMediaKind = 'auto' | 'voice';
export interface SendMediaRequest { uploadId: string; kind: SendMediaKind; quotedId?: string | null }

/** `POST /api/messages/:messageId/react`: an empty `emoji` removes the owner's reaction. */
export interface ReactRequest { emoji: string }
/** `POST /api/messages/:messageId/edit` (own text messages, within Instagram's time limit). */
export interface EditRequest { text: string }

/* ------------------------------------------------------------------ events */

export type ServerEvent =
  | { type: 'ig_state'; status: IgStatus }
  | { type: 'message'; chatId: string; messageId: string }
  | { type: 'message_update'; chatId: string; messageId: string; reason: 'deleted' | 'edited' | 'reaction' | 'ack' | 'media' }
  | { type: 'chat_update'; chatId: string }
  | { type: 'sync_progress'; sync: IgStatus['sync'] }
  | { type: 'session_revoked' };

/* ---------------------------------------------------------------- settings */

export interface Settings {
  downloadHistoryMedia: boolean;
  mediaMaxMb: number; // 1..2000
  historyPerChat: number; // 0..2000
  /** Mark a chat as seen on Instagram ("Seen" for the sender) when it is opened here. Default false. */
  readReceipts: boolean;
}

export interface AuditEntry { id: number; ts: number; event: string; ip: string | null; detail: string | null }

export interface WipeRequest { password: string; totp?: string }
