import type { IgPage } from './page.js';
import type { IgEdged, IgMessage, IgThread } from './types.js';

/** Who is logged in, read from Instagram Web's own page data. */
export interface PageViewer {
  /** Messaging id (IG_USER_EIMU): the sender id on the account's own messages. */
  fbid: string | null;
  /** Instagram user id (pk). */
  igId: string | null;
  username: string | null;
  name: string | null;
  /** Device id Instagram Web uses for its message stream (needed by the inbox query). */
  deviceId: string | null;
}

export interface ThreadPage {
  threads: IgThread[];
  cursor: string | null;
  hasMore: boolean;
  viewerFbid: string | null;
}

export interface MessagesPage {
  messages: IgMessage[]; // newest first, as Instagram returns them
  cursor: string | null;
  hasMore: boolean;
  /** Instagram said explicitly that there are no older messages. */
  atStart: boolean;
}

const RELAY_PROVIDERS = {
  __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
  __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
  __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
  __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true,
};
const PAGE_SIZE = 20;

/** 64-bit random decimal string, as Instagram Web uses for offline threading ids. */
export function offlineThreadingId(): string {
  const now = BigInt(Date.now());
  const rnd = BigInt(Math.floor(Math.random() * 0x3fffff));
  return ((now << 22n) | rnd).toString();
}

function edgesOf(e: IgEdged<{ as_ig_direct_thread?: IgThread | null; id?: string }> | null | undefined): IgThread[] {
  const out: IgThread[] = [];
  for (const edge of e?.edges ?? []) {
    const t = edge?.node?.as_ig_direct_thread;
    if (t) out.push(t);
  }
  return out;
}

/** Instagram Web's direct-message GraphQL queries and mutations, run inside its tab (see page.ts). */
export class IgClient {
  constructor(private readonly page: IgPage) {}

  async viewer(): Promise<PageViewer> {
    return this.page.page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const W = window as any;
      const R = (n: string): any => {
        try {
          return W.require(n);
        } catch {
          return null;
        }
      };
      const s = (v: unknown) => (typeof v === 'string' && v && v !== '0' ? v : typeof v === 'number' && v > 0 ? String(v) : null);
      const cu = R('CurrentUserInitialData') ?? {};
      const pv = R('PolarisViewer')?.data ?? {};
      return {
        fbid: s(cu.IG_USER_EIMU),
        igId: s(pv.id) ?? s(cu.NON_FACEBOOK_USER_ID),
        username: s(pv.username),
        name: s(pv.full_name),
        deviceId: s(R('IGDMqttWebDeviceID')?.clientId),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
  }

  /** The newest threads of the inbox (first page). */
  async inbox(deviceId: string | null): Promise<ThreadPage> {
    const data = await this.page.graphql<{
      get_slide_mailbox_for_iris_subscription?: {
        id?: string;
        threads_by_folder?: IgEdged<{ as_ig_direct_thread?: IgThread | null }>;
        pinned_threads_v2?: { as_ig_direct_thread?: IgThread | null }[] | null;
      } | null;
    }>('PolarisDirectInboxQuery', {
      device_id_for_iris_subscription: deviceId ?? '',
      __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: false,
      ...RELAY_PROVIDERS,
    });
    const mb = data.get_slide_mailbox_for_iris_subscription;
    const threads = edgesOf(mb?.threads_by_folder);
    for (const p of mb?.pinned_threads_v2 ?? []) if (p?.as_ig_direct_thread) threads.push(p.as_ig_direct_thread);
    const pi = mb?.threads_by_folder?.page_info;
    return { threads, cursor: pi?.end_cursor ?? null, hasMore: pi?.has_next_page === true, viewerFbid: typeof mb?.id === 'string' ? mb.id : null };
  }

  /** The next page of a folder ("INBOX" or the message requests folder). */
  async inboxPage(viewerFbid: string, cursor: string, folder = 'INBOX'): Promise<ThreadPage> {
    const data = await this.page.graphql<{ fetch__SlideMailbox?: { threads_by_folder?: IgEdged<{ as_ig_direct_thread?: IgThread | null }> } | null }>(
      'IGDThreadListOffMsysPaginationQuery',
      { count: PAGE_SIZE, cursor, folder, newer_than_timestamp_ms: null, id: viewerFbid, ...RELAY_PROVIDERS },
    );
    const t = data.fetch__SlideMailbox?.threads_by_folder;
    return { threads: edgesOf(t), cursor: t?.page_info?.end_cursor ?? null, hasMore: t?.page_info?.has_next_page === true, viewerFbid };
  }

  /** A thread with its newest messages. */
  async thread(chatId: string): Promise<IgThread | null> {
    const data = await this.page.graphql<{ get_slide_thread_nullable?: { as_ig_direct_thread?: IgThread | null } | null }>('IGDThreadDetailQuery', {
      min_uq_seq_id: null,
      thread_fbid: chatId,
      __relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider: false,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: PAGE_SIZE,
      __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
    });
    return data.get_slide_thread_nullable?.as_ig_direct_thread ?? null;
  }

  /** Older messages: after a page cursor, or older than a message id. Newest first. */
  async messages(chatId: string, opts: { after?: string | null; olderThan?: string | null }): Promise<MessagesPage> {
    const data = await this.page.graphql<{ fetch__SlideThread?: { as_ig_direct_thread?: { slide_messages?: IgEdged<IgMessage> | null } | null } | null }>(
      'IGDMessageListOffMsysQuery',
      {
        after: opts.after ?? null,
        before: null,
        first: PAGE_SIZE,
        last: null,
        newer_than_message_id: null,
        older_than_message_id: opts.olderThan ?? null,
        id: chatId,
        __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: PAGE_SIZE,
      },
    );
    const sm = data.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;
    const messages: IgMessage[] = [];
    for (const e of sm?.edges ?? []) if (e?.node) messages.push(e.node);
    return { messages, cursor: sm?.page_info?.end_cursor ?? null, hasMore: sm?.page_info?.has_next_page === true, atStart: sm?.page_info?.has_next_page === false };
  }

  /* -------------------------------------------------------------- sending */

  async sendText(chatId: string, text: string, replyTo: string | null): Promise<string | null> {
    const data = await this.page.graphql<{ xig_direct_text_send_with_slide_messaging_response?: { message_id?: string; id?: string } | null }>(
      'IGDirectTextSendMutation',
      {
        ig_thread_igid: chatId,
        offline_threading_id: offlineThreadingId(),
        recipient_igids: null,
        replied_to_client_context: null,
        replied_to_item_id: null,
        reply_to_message_id: replyTo,
        sampled: null,
        text: { sensitive_string_value: text },
        mentions: [],
        mentioned_user_ids: [],
        commands: [],
        forwarded_from_thread_id: null,
        is_forwarded_from_own_message: null,
        send_attribution: 'igd_web_chat_tab:in_thread',
      },
      60_000,
    );
    const r = data.xig_direct_text_send_with_slide_messaging_response;
    return r?.message_id ?? r?.id ?? null;
  }

  async sendMedia(chatId: string, attachmentFbid: string, replyTo: string | null): Promise<string | null> {
    const data = await this.page.graphql<{ xig_direct_media_send_with_slide_messaging_response?: { message_id?: string; id?: string } | null }>(
      'IGDirectMediaSendMutation',
      {
        attachment_fbid: attachmentFbid,
        thread_id: chatId,
        offline_threading_id: offlineThreadingId(),
        reply_to_message_id: replyTo,
        forwarded_from_thread_id: null,
        is_forwarded_from_own_message: null,
      },
      120_000,
    );
    const r = data.xig_direct_media_send_with_slide_messaging_response;
    return r?.message_id ?? r?.id ?? null;
  }

  async react(chatId: string, messageId: string, emoji: string, remove: boolean): Promise<void> {
    await this.page.graphql('IGDirectReactionSendMutation', {
      input: { emoji, item_id: '', message_id: messageId, reaction_status: remove ? 'deleted' : 'created', thread_id: chatId },
    });
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.page.graphql('IGDirectEditMessageMutation', {
      thread_id: chatId,
      target_item_id: '',
      body: { sensitive_string_value: text },
      offline_threading_id: offlineThreadingId(),
      target_message_id: messageId,
    });
  }

  async unsend(longThreadId: string, messageId: string): Promise<boolean> {
    const data = await this.page.graphql<{ direct_unsend_message?: boolean }>('IGDMessageUnsendDialogOffMsysMutation', {
      message_id: messageId,
      send_data: { thread_id: longThreadId },
    });
    return data.direct_unsend_message !== false;
  }

  async markSeen(longThreadId: string, messageId: string): Promise<void> {
    await this.page.graphql('useIGDMarkThreadAsReadMutation', {
      metadata: { ig_thread_igid: longThreadId },
      data: { message_id: messageId, item_id: '' },
    });
  }

  /**
   * Uploads a file the way Instagram Web's composer does (multipart "farr" to /ajax/mercury/upload.php) and returns
   * the attachment id to send. The bytes are pushed into the page in chunks first (see sender.ts).
   */
  async upload(token: string, mime: string, filename: string, voice: boolean, origin: string): Promise<string> {
    const r = await this.page.page.evaluate(
      async (o: { token: string; mime: string; filename: string; voice: boolean; url: string }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const W = window as any;
        const store: Map<string, { parts: Uint8Array[] }> | undefined = W.__iglUploads;
        const entry = store?.get(o.token);
        if (!entry) return { ok: false, code: 'gone' };
        store!.delete(o.token);
        const P: Record<string, string> = {};
        try {
          const ap = W.require('getAsyncParams')('POST');
          for (const k of Object.keys(ap)) if (ap[k] !== undefined && ap[k] !== null) P[k] = String(ap[k]);
        } catch {
          /* tokens below */
        }
        try {
          if (!P.fb_dtsg) P.fb_dtsg = W.require('DTSGInitData')?.token ?? '';
        } catch {
          /* ignore */
        }
        const form = new FormData();
        if (o.voice) form.append('voice_clip', 'true');
        form.append('farr', new Blob(entry.parts as BlobPart[], { type: o.mime }), o.filename);
        const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        const headers: Record<string, string> = {};
        if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf[1]!);
        if (P.lsd) headers['x-fb-lsd'] = P.lsd;
        try {
          const res = await fetch(`${o.url}?${new URLSearchParams(P).toString()}`, { method: 'POST', body: form, credentials: 'include', headers });
          let text = await res.text();
          if (text.startsWith('for (;;);')) text = text.slice(9);
          // Ids can exceed 2^53: read them from the text, never through JSON numbers.
          for (const k of ['video_id', 'audio_id', 'image_id', 'gif_id', 'file_id']) {
            const m = new RegExp(`"${k}"\\s*:\\s*"?(\\d{1,24})"?`).exec(text);
            if (m && !/^0+$/.test(m[1]!)) return { ok: true, id: m[1]! };
          }
          const err = /"error"\s*:\s*(\d{1,10})/.exec(text);
          return { ok: false, code: err ? `error_${err[1]}` : 'no_id' };
        } catch (e: any) {
          return { ok: false, code: String(e?.name ?? 'error').slice(0, 40) };
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { token, mime, filename, voice, url: `${origin}/ajax/mercury/upload.php` },
    );
    if (!r.ok || !('id' in r) || !r.id) throw new Error(`upload failed (${'code' in r ? r.code : 'unknown'})`);
    return r.id;
  }

  /** Starts a chunked upload buffer inside the page. */
  async uploadBegin(): Promise<string> {
    return this.page.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const W = window as any;
      const store: Map<string, { parts: Uint8Array[]; t: number }> = (W.__iglUploads ||= new Map());
      for (const [k, v] of store) if (Date.now() - v.t > 15 * 60_000) store.delete(k);
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      store.set(token, { parts: [], t: Date.now() });
      return token;
    });
  }

  async uploadChunk(token: string, b64: string): Promise<void> {
    const ok = await this.page.page.evaluate(
      (t: string, data: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = (window as any).__iglUploads?.get(t);
        if (!e) return false;
        const bin = atob(data);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        e.parts.push(u8);
        return true;
      },
      token,
      b64,
    );
    if (!ok) throw new Error('upload buffer gone');
  }

  async uploadDrop(token: string): Promise<void> {
    await this.page.page.evaluate((t: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__iglUploads?.delete(t);
    }, token);
  }
}
