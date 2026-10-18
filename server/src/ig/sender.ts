import type { SendMediaKind, SendResult } from '../../../shared/api.js';
import type { AppContext, IgSender } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { maskId } from '../log.js';
import type { IgClient } from './api.js';
import { beginMediaFile, finishMediaFile } from './media.js';
import { IgRequestError } from './page.js';

const CHUNK = 1024 * 1024;
/** Sends per rolling hour, on top of the per-route rate limits: a stolen session must not get the account banned. */
const MAX_SENDS_PER_HOUR = 200;

/** Instagram request errors → API errors (generic texts; nothing from Instagram's answer is passed on). */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof IgRequestError) {
    switch (e.code) {
      case 'login':
        return Errors.unavailable('Instagram is logged out. Log in again on the Instagram screen.');
      case 'timeout':
        return new AppError(504, 'timeout', 'Instagram did not answer in time.');
      case 'reload':
        return Errors.unavailable('Instagram Web is updating. Try again in a moment.');
      default:
        return new AppError(502, 'send_failed', 'Instagram did not accept that.');
    }
  }
  return new AppError(502, 'ig_error', 'Instagram could not do that.');
}

/** Instagram's own id of a row (album parts share the message's id). */
export const igMessageId = (rowId: string) => rowId.replace(/~\d+$/, '');

/**
 * Sending through Instagram Web's own GraphQL mutations, run inside its tab. What gets sent comes back through the
 * message stream and is logged like everything else; media we sent is stored from the uploaded file.
 */
export class Sender implements IgSender {
  private readonly sent: number[] = [];
  /** Messages whose file is being stored from the owner's upload (the media queue leaves them alone). */
  private readonly uploading = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly client: () => IgClient | null,
    private readonly ensureThreadId: (chatId: string) => Promise<string | null>,
  ) {}

  private api(): IgClient {
    const c = this.client();
    if (!c) throw Errors.unavailable('Instagram is not connected.');
    return c;
  }

  private charge(): void {
    const now = Date.now();
    while (this.sent.length && this.sent[0]! < now - 3600_000) this.sent.shift();
    if (this.sent.length >= MAX_SENDS_PER_HOUR) throw Errors.rateLimited((this.sent[0]! + 3600_000 - now) / 1000);
    this.sent.push(now);
  }

  private async run<T>(fn: (c: IgClient) => Promise<T>): Promise<T> {
    const c = this.api();
    try {
      return await fn(c);
    } catch (e) {
      throw toAppError(e);
    }
  }

  private message(messageId: string) {
    const row = this.ctx.repo.getMessage(messageId);
    if (!row) throw Errors.notFound('Message');
    return row;
  }

  async sendText(chatId: string, text: string, quotedId: string | null): Promise<SendResult> {
    this.charge();
    const id = await this.run((c) => c.sendText(chatId, text, quotedId ? igMessageId(quotedId) : null));
    this.ctx.repo.audit('message_sent', null, 'text');
    return { id };
  }

  async sendMedia(chatId: string, file: { data: Buffer; mime: string; filename: string | null }, kind: SendMediaKind, quotedId: string | null): Promise<SendResult> {
    this.charge();
    const c = this.api();
    let token: string | null = null;
    try {
      token = await c.uploadBegin();
      for (let off = 0; off < file.data.length; off += CHUNK) await c.uploadChunk(token, file.data.subarray(off, off + CHUNK).toString('base64'));
      const ext = (file.mime.split('/')[1] ?? 'bin').split(/[;+]/)[0];
      const attachment = await c.upload(token, file.mime, file.filename ?? `upload.${ext}`, kind === 'voice', this.ctx.config.igWebOrigin);
      token = null; // the page dropped it
      const id = await c.sendMedia(chatId, attachment, quotedId ? igMessageId(quotedId) : null);
      this.ctx.repo.audit('message_sent', null, kind === 'voice' ? 'voice' : 'media');
      if (id) {
        this.uploading.add(id);
        void this.storeSentMedia(id, file)
          .catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'storing sent media failed'))
          .finally(() => this.uploading.delete(id));
      }
      return { id };
    } catch (e) {
      if (e instanceof Error && /^upload failed/.test(e.message)) throw new AppError(502, 'send_failed', 'Instagram did not accept the file.');
      throw toAppError(e);
    } finally {
      if (token) await c.uploadDrop(token).catch(() => undefined);
    }
  }

  isUploading(messageId: string): boolean {
    return this.uploading.has(messageId);
  }

  /** Stores the uploaded bytes for the message the upload became, so it never has to be downloaded again. */
  async storeSentMedia(messageId: string, file: { data: Buffer; mime: string; filename: string | null }): Promise<void> {
    const { repo, events } = this.ctx;
    let row = repo.findMessage(messageId);
    for (let i = 0; !row && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      row = repo.findMessage(messageId);
    }
    if (!row || row.media_id || row.media_status === 'downloaded' || row.album_count) return;
    const f = await beginMediaFile(this.ctx);
    try {
      await f.writer.write(file.data);
    } catch (e) {
      await f.writer.abort();
      throw e;
    }
    const { mediaId, size } = await finishMediaFile(this.ctx, f, 'message', file.mime, file.filename);
    const now = repo.getMessage(row.id);
    if (!now || now.media_id) return;
    repo.updateMessage(row.id, { media_id: mediaId, media_status: 'downloaded', media_size: size, updated_at: Date.now() });
    events.emit({ type: 'message_update', chatId: row.chat_id, messageId: row.id, reason: 'media' });
    this.ctx.log.debug({ msg: maskId(row.id) }, 'stored sent media');
  }

  async react(messageId: string, emoji: string, previous: string | null = null): Promise<void> {
    this.charge();
    const row = this.message(messageId);
    const remove = emoji === '';
    if (remove && !previous) return;
    await this.run((c) => c.react(row.chat_id, igMessageId(row.id), remove ? previous! : emoji, remove));
  }

  async unsend(messageId: string): Promise<void> {
    this.charge();
    const row = this.message(messageId);
    if (!row.from_me) throw Errors.conflict('Only your own messages can be unsent.');
    const threadId = await this.ensureThreadId(row.chat_id);
    if (!threadId) throw Errors.unavailable('Instagram did not return this chat. Try again in a moment.');
    const ok = await this.run((c) => c.unsend(threadId, igMessageId(row.id)));
    if (!ok) throw new AppError(502, 'send_failed', 'Instagram did not unsend it.');
    this.ctx.repo.audit('message_unsent', null);
  }

  async edit(messageId: string, text: string): Promise<void> {
    this.charge();
    const row = this.message(messageId);
    await this.run((c) => c.edit(row.chat_id, igMessageId(row.id), text));
  }

  async markRead(chatId: string): Promise<void> {
    const last = this.ctx.repo.listMessagesBefore(chatId, null, 20).reverse().find((r) => !r.from_me && !r.deleted_at);
    if (!last) return;
    const threadId = await this.ensureThreadId(chatId);
    if (!threadId) return;
    await this.run((c) => c.markSeen(threadId, igMessageId(last.id)));
  }
}
