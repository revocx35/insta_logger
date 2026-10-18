import { describe, expect, it } from 'vitest';
import { ALI, AYSE, CHAT, adminMsg, albumMsg, at, imageMsg, mid, ravenMsg, shareMsg, stickerMsg, textMsg, videoMsg, voiceMsg } from '../testutil/igfixtures.js';
import { mapMessage, mapShare, ms } from './mapper.js';

describe('mapMessage', () => {
  it('maps text with sender, time, mentions and forwarding', () => {
    const raw = { ...textMsg(mid(1), 'hi @ayse', at(1), { forwarded: true }), mentions: [{ offset: 3, length: 5, profile_range_type: 'PROFILE', user_fbid: AYSE }] };
    const m = mapMessage(raw);
    expect(m.skip).toBe(false);
    expect(m).toMatchObject({ id: mid(1), chatId: CHAT, senderId: ALI, ts: at(1), forwarded: true });
    expect(m.parts).toEqual([expect.objectContaining({ id: mid(1), type: 'text', body: 'hi @ayse', media: null, meta: { mentions: [AYSE] } })]);
    expect(m.sender).toMatchObject({ id: ALI, username: 'ali.veli', name: 'Ali Veli' });
  });

  it('keeps a snapshot of the quoted message', () => {
    const q = textMsg(mid(2), 'original', at(2), { sender: AYSE });
    const m = mapMessage(textMsg(mid(3), 'reply', at(3), { reply: { id: mid(2), message: q } }));
    expect(m.quotedId).toBe(mid(2));
    expect(m.parts[0]!.meta?.quoted).toEqual({ id: mid(2), senderId: AYSE, type: 'text', text: 'original' });
  });

  it('maps photos, videos and voice messages with download links', () => {
    const img = mapMessage(imageMsg(mid(4), at(4)));
    expect(img.parts[0]).toMatchObject({ type: 'image', media: { width: 1080, height: 1350, source: { url: expect.stringMatching(/^https:\/\/scontent/), mime: 'image/jpeg' } } });
    const vid = mapMessage(videoMsg(mid(5), at(5)));
    expect(vid.parts[0]).toMatchObject({ type: 'video', media: { durationSec: 12, source: { mime: 'video/mp4' } } });
    const voice = mapMessage(voiceMsg(mid(6), at(6)));
    expect(voice.parts[0]).toMatchObject({ type: 'voice', media: { durationSec: 7, source: { url: expect.stringContaining('voice.mp4') } } });
  });

  it('splits albums into one row per photo/video', () => {
    const m = mapMessage(albumMsg(mid(7), at(7)));
    expect(m.parts.map((p) => [p.id, p.type, p.albumIndex, p.albumCount])).toEqual([
      [mid(7), 'image', 0, 3],
      [`${mid(7)}~1`, 'video', 1, 3],
      [`${mid(7)}~2`, 'image', 2, 3],
    ]);
  });

  it('never gives view-once media a download link; keep-in-chat raven media is ordinary', () => {
    for (const mode of [0, 1]) {
      const m = mapMessage(ravenMsg(mid(8), at(8), mode));
      expect(m.parts[0]).toMatchObject({ type: 'view_once', viewOnce: true, media: { source: null } });
    }
    expect(mapMessage(ravenMsg(mid(9), at(9), 2)).parts[0]).toMatchObject({ type: 'image', viewOnce: false, media: { source: { url: expect.any(String) } } });
  });

  it('maps shared reels/posts with their preview image and text', () => {
    const m = mapMessage(shareMsg(mid(10), at(10), {}, 'look at this'));
    expect(m.parts[0]).toMatchObject({ type: 'share', body: 'look at this', media: { width: 540, height: 960, source: { url: expect.stringContaining('reel_preview') } } });
    expect(m.parts[0]!.meta?.share).toEqual({ kind: 'Reel', title: 'natgeo', subtitle: null, caption: 'A whale breaching at sunrise', url: 'https://www.instagram.com/reel/C0ffee123/', eyebrow: null });
  });

  it('unwraps redirect links and classifies share targets', () => {
    expect(mapShare({ target_url: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2Fa&e=x' })!.share).toMatchObject({ url: 'https://example.com/a', kind: 'Link' });
    expect(mapShare({ target_url: 'https://www.instagram.com/p/abc/' })!.share.kind).toBe('Post');
    expect(mapShare({ target_url: 'https://www.instagram.com/stories/someone/123/' })!.share.kind).toBe('Story');
    expect(mapShare({ target_url: 'https://www.instagram.com/someone/' })!.share.kind).toBe('Profile');
    expect(mapShare({ target_url: 'javascript:alert(1)' })!.share.url).toBeNull();
  });

  it('maps stickers, admin texts and unknown content', () => {
    expect(mapMessage(stickerMsg(mid(11), at(11))).parts[0]).toMatchObject({ type: 'sticker', body: 'waving bear', media: { source: { url: expect.stringContaining('sticker.webp') } } });
    expect(mapMessage(adminMsg(mid(12), at(12), 'Ali named the group Weekend plans')).parts[0]).toMatchObject({ type: 'system', body: 'Ali named the group Weekend plans', media: null });
    const unknown = mapMessage({ ...textMsg(mid(13), 'x', at(13)), igd_snippet: 'sent a poll', content: { __typename: 'SlideMessagePollContent' } });
    expect(unknown.parts[0]).toMatchObject({ type: 'unknown', body: 'sent a poll', meta: { rawType: 'SlideMessagePollContent' } });
  });

  it('reads edit history and reactions', () => {
    const m = mapMessage(
      textMsg(mid(14), 'final text', at(14), {
        edits: [
          { body: 'first try', ts: at(14) + 1000 },
          { body: 'final text', ts: at(14) + 5000 },
        ],
        reactions: [{ sender: AYSE, emoji: '❤️' }],
      }),
    );
    expect(m.editTs).toBe(at(14) + 5000);
    expect(m.previousBodies.map((p) => p.body)).toEqual(['first try']);
    expect(m.reactions).toEqual([{ senderId: AYSE, emoji: '❤️', ts: at(14) + 1000 }]);
  });

  it('skips messages without a usable id or time', () => {
    expect(mapMessage(null).skip).toBe(true);
    expect(mapMessage({ ...textMsg(mid(15), 'x', at(15)), message_id: undefined, id: undefined }).skip).toBe(true);
    expect(mapMessage({ ...textMsg('bad/id', 'x', at(15)), id: 'bad/id' }).skip).toBe(true);
    expect(mapMessage({ ...textMsg(mid(16), 'x', at(16)), timestamp_ms: 'soon' }).skip).toBe(true);
    // Instagram's second id is kept when it differs.
    expect(mapMessage(textMsg(mid(17), 'x', at(17), { altId: 'other-id-17' })).altId).toBe('other-id-17');
  });

  it('parses timestamps in seconds or milliseconds', () => {
    expect(ms('1760000000000')).toBe(1760000000000);
    expect(ms(1760000000)).toBe(1760000000000);
    expect(ms('0')).toBeNull();
    expect(ms('12abc')).toBeNull();
  });
});
