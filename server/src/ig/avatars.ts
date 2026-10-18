import type { AppContext } from '../context.js';
import { maskId } from '../log.js';
import { deleteMediaFile, downloadToMedia, isInstagramCdn, type Downloader } from './media.js';

const REFRESH_AFTER_MS = 3 * 86400_000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Best-effort chat pictures (group image, or the other person's profile picture). The URLs come from thread data
 * Instagram already sent; the image is fetched *by the browser* (the app container has no internet access) and
 * stored encrypted like any other media.
 */
export async function refreshAvatars(ctx: AppContext, dl: Downloader, urls: Map<string, string>, batch = 15): Promise<number> {
  const now = Date.now();
  let updated = 0;
  for (const chat of ctx.repo.chatsNeedingAvatar(now - REFRESH_AFTER_MS, batch * 3)) {
    if (updated >= batch) break;
    const url = urls.get(chat.id) ?? (chat.peer_id ? urls.get(`c:${chat.peer_id}`) : undefined);
    // No link yet: try again after the next reconcile delivered one.
    if (!url || !isInstagramCdn(url, ctx.config.igWebOrigin)) continue;
    try {
      const old = chat.avatar_media_id ? ctx.repo.getMedia(chat.avatar_media_id) : undefined;
      const out = await downloadToMedia(ctx, dl, url, 'avatar', 'image/jpeg', MAX_AVATAR_BYTES);
      if (out.status !== 'ok') {
        ctx.repo.setChatAvatar(chat.id, old?.id ?? null, now);
        continue;
      }
      ctx.repo.setChatAvatar(chat.id, out.mediaId, now);
      if (old) {
        ctx.repo.deleteMedia(old.id);
        await deleteMediaFile(ctx, old.path);
      }
      updated++;
      ctx.events.emit({ type: 'chat_update', chatId: chat.id });
    } catch (err) {
      ctx.log.debug({ err: (err as Error).message, chat: maskId(chat.id) }, 'avatar refresh failed');
      ctx.repo.setChatAvatar(chat.id, chat.avatar_media_id, now);
    }
  }
  return updated;
}
