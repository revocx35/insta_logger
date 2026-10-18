# Instagram Web — facts insta_logger relies on

What the code assumes about Instagram's website (state of 2026-10). Most of it was worked out from the open-source
mautrix-meta bridge (`pkg/messagix/dgw`, `pkg/instameow`, `pkg/instameow/slidetypes`, `pkg/messagix/graphql/docs.go`,
commit 838bf93 of 2026-10-17), which emulates Instagram Web, and checked against the real instagram.com where possible
without an account. When Instagram changes something, update this file with the code.

## Page and login

* `https://www.instagram.com/direct/inbox/` is the inbox; `/direct/t/<thread>/` an open conversation (marks new
  messages "Seen"); `/accounts/login/` the login page (redirects to `/` when already logged in); `/challenge/…`,
  `/two_factor…`, `/auth_platform/…`, `/consent/…`, `/accounts/suspended/` are checks the owner answers;
  `/accounts/onetap/` ("save your login info?") comes after a successful login.
* The login page loads from `www.instagram.com`, `static.cdninstagram.com` and `www.facebook.com` (checked in the
  container's Chromium, 2026-10-18; it renders fully with the URL policy). Login cookies: `sessionid` (HttpOnly),
  `ds_user_id` (Instagram user id), `csrftoken`.
* Page modules (`window.require(name)`, present on the logged-out login page too, checked 2026-10-18):
  `getAsyncParams` (function → the common POST params `__d __user __a __req __hs dpr __ccg __rev __s __hsi __dyn __csr
  __hsdp __hblp __sjsp __comet_req lsd jazoest __spin_r __spin_b __spin_t __crn`; `fb_dtsg` when logged in),
  `DTSGInitData` (`token`), `LSD` (`token`), `CurrentUserInitialData` (`IG_USER_EIMU` = the account's **messaging id**,
  `NON_FACEBOOK_USER_ID`, `USER_ID`), `PolarisViewer` (`data: {id, username, full_name, fbid}` when logged in),
  `IGDMqttWebDeviceID` (`clientId`), `DGWWebConfig` (`appId`, `dgwVersion`…).

## Stream

* Instagram Web keeps a WebSocket to `wss://gateway.instagram.com/ws/lightspeed` ("DGW", Direct Gateway).
  insta_logger never writes to it; it reads the browser's received frames over CDP.
* WebSocket binary message = one or more DGW frames. Frame types: 3 drain (5 bytes), 4 deauth, 9 ping, 10 pong (1 byte),
  12 ack, 13 data, 14 end-of-data, 15 establish-stream, 16 end-of-data-with-reason, 17 extended data. Data frame:
  `type u8 · streamId u16le · length u24le (bytes after this field) · ackId u15le + requiresAck bit 15 ·
  [contentType u8 for type 17] · payload`.
* Main stream payload = JSON `{"request_id": …, "payload": "<base64>"}`; the base64 is protobuf `LSResponse`
  (`MDCoreSync.proto`): `repeated Operation operations = 2`; Operation oneof: `1 OnIrisSubscribe {groupID, subscribedSeqID,
  latestSeqID}`, `2 OnResnapshot {groupID, errorMessage, errorType, snapshotPayload}`, `3 OnMailboxDelta {groupID,
  string delta}`, `4 Noop`, `5 HandleSyncFailure {groupID, errorMessage}`.
* `delta` is JSON: `[{"data":{"slide_delta_processor":[Delta, …]}}]`. Each Delta has `__typename`, `uq_seq_id`,
  `thread_fbid` (= our chat id) and type-specific fields:
  `SlideUQPPNewMessage` / `…NewRavenMessage` / `…NewGenieMessage` / `SlideUQPPAdminTextMessage` → `message`;
  `SlideUQPPDeleteMessage` → `message_id` (**unsend**); `SlideUQPPEditMessage` → `message_id`, `text_body`,
  `slide_edit_history_entry.timestamp_ms`; `SlideUQPPCreateReaction` / `…DeleteReaction` → `message_id`,
  `reaction {reaction, sender_fbid, reaction_timestamp_ms, log_message_id}` (a removal may name the reaction's
  `log_message_id` instead of the message); `SlideUQPPReadReceipt` → `read_receipt {participant_fbid,
  watermark_timestamp_ms}`; `SlideUQPPThreadName` → `thread_name`, `message`; `SlideUQPPThreadImage`;
  `SlideUQPPParticipantsAddedToGroupThread` / `…LeftGroupThread` → `message`, `thread`; `SlideUQPPPinnedThread` →
  `is_pinned`; `SlideUQPPChangeMuteSettings` → `is_muted_now`; `SlideUQPPUpdateThreadFolder` → `folder`;
  `SlideUQPPDeleteThread`; ignored: MarkRead, MarkThreadUnread, PinUnpinMessage, admin lists, NoOp, typing.
* Ids can be bare JSON numbers above 2^53: parse with exact big integers (`parseJsonExact`).
* Our decoder was cross-checked with frames encoded by mautrix-meta's Go code (2026-10-18).

## Messages ("Slide" JSON)

* `message_id` (our id; also used by unsend/edit/reaction deltas), `id` (usually the same; kept as `alt_id` when not),
  `sender_fbid` (messaging id), `thread_fbid`, `timestamp_ms` (string), `content.__typename`, `text_body`,
  `igd_snippet` (the inbox preview text), `replied_to_message_id` + `replied_to_message`, `reactions[]`, `mentions[]`
  (`user_fbid`, `profile_range_type` PROFILE), `igd_is_forwarded`, `slide_edit_history[] {body, timestamp_ms}`,
  `expiration_timestamp_ms` (disappearing), `sender.user_dict` (a full user: `interop_messaging_user_fbid`, `id`,
  `username`, `full_name`, `profile_pic_url`).
* Content types: `SlideMessageText`, `…AdminText` (`text_fragments[].plaintext`), `…ImageContent` (`attachments[]`),
  `…VideosContent` (`videos[]`), `…MultiMediaContent` (`ordered_photo_video_attachments[]`), `…AudiosContent`
  (`audio_attachments[] {attachment_cdn_url, playable_duration_ms}`), `…AnimatedMediaContent` (`attachment_webp_url`,
  `attachment_mp4_url`, `is_sticker`), `…RavenImageContent` / `…RavenVideoContent` (`view_mode` 0 view once,
  1 allow replay, 2 keep in chat; `attachment`), sticker types (`preview_url`, `alt_text`), `…XMAContent` (shares:
  `xma {header_title_text, title_text, subtitle_text, caption_body_text, target_url, preview_image{url,width,height},
  eyebrow_text}`, `xma_text_body`), `…MusicStickerXMAContent` (`audio_track.web_30s_preview_download_url`), AI responses.
* Attachments: `attachment_cdn_url` (videos: progressive MP4), `attachment_cdn_fallback_url`, `preview_cdn_url`,
  `preview_width/height`, `dash_manifest` for videos. Links are signed (`oe=` expiry) and expire after days.
* Threads (`as_ig_direct_thread`): `id` = `thread_fbid` (our chat id), `thread_id` (the **long** id unsend and "seen"
  need), `thread_key`, `is_group` / `thread_subtype` (`IGD_GROUP`), `thread_title`, `thread_image_url`, `users[]`,
  `viewer`, `last_activity_timestamp_ms`, `slide_messages {edges[].node, page_info}` (newest first),
  `slide_read_receipts`, `is_muted`, `is_pin`, `folder` / `system_folder`.

## GraphQL

`POST https://www.instagram.com/api/graphql`, form-encoded: the common params above + `fb_api_caller_class=RelayModern`,
`fb_api_req_friendly_name`, `variables` (JSON), `server_timestamps=true`, `doc_id`; headers `x-csrftoken`, `x-fb-lsd`,
`x-fb-friendly-name`, `x-ig-app-id` (936619743392459), `x-asbd-id`. Answers start with `for (;;);`; deferred parts come
as extra JSON lines with `path`. `{"error":1357001}` = logged out, `1357004` = reload the page.

| Query / mutation | Doc id (default) | Variables (main) | Answer |
|---|---|---|---|
| PolarisDirectInboxQuery | 27262915580045003 | `device_id_for_iris_subscription` + relay providers | `get_slide_mailbox_for_iris_subscription {id, threads_by_folder, pinned_threads_v2}` |
| IGDThreadListOffMsysPaginationQuery | 27712934271665380 | `count, cursor, folder: INBOX, id: <viewer messaging id>` | `fetch__SlideMailbox.threads_by_folder` |
| IGDThreadDetailQuery | 37117700834487428 | `thread_fbid`, `min_uq_seq_id: null`, page count 20 | `get_slide_thread_nullable.as_ig_direct_thread` |
| IGDMessageListOffMsysQuery | 27502152406082940 | `id, first: 20, after` or `older_than_message_id` | `fetch__SlideThread.as_ig_direct_thread.slide_messages` |
| IGDirectTextSendMutation | 26911679871773184 | `ig_thread_igid, offline_threading_id, text.sensitive_string_value, reply_to_message_id, send_attribution` | `xig_direct_text_send_with_slide_messaging_response {message_id}` |
| IGDirectMediaSendMutation | 25766288509716264 | `attachment_fbid, thread_id, offline_threading_id, reply_to_message_id` | `xig_direct_media_send_with_slide_messaging_response` |
| IGDirectReactionSendMutation | 24374451552236906 | `input {emoji, item_id:'', message_id, reaction_status: created/deleted, thread_id}` | |
| IGDirectEditMessageMutation | 32480262318254796 | `thread_id, target_message_id, body.sensitive_string_value, offline_threading_id` | |
| IGDMessageUnsendDialogOffMsysMutation | 26948700068153789 | `message_id, send_data.thread_id` (**long** thread id) | `direct_unsend_message` |
| useIGDMarkThreadAsReadMutation | 27356881703909995 | `metadata.ig_thread_igid` (long id), `data {message_id, item_id:''}` | |

Doc ids change with Instagram Web builds; the app learns the current ones from the tab's own requests (`docs.ts`).

Uploads: multipart `farr` (+ `voice_clip=true`) to `/ajax/mercury/upload.php?<common params>`; the answer's
`payload.metadata` holds `image_id` / `video_id` / `audio_id` / `gif_id` / `file_id` (bare numbers above 2^53).

## First live check (to do with the owner's account)

1. Log in through the Instagram screen; the state must reach `ready` and the history import must show chats.
2. Receive a message from another account; it must appear live. Unsend it; it must stay with the red "Unsent" badge.
3. Send a text, a reply, a reaction, a photo and a voice message from insta_logger; check them in the Instagram app.
4. `docker compose logs app | grep -i 'failed\|error'` — GraphQL errors name the query (never content).
5. If something fails, compare the tab's real requests (Settings → Instagram shows the last live update time).
