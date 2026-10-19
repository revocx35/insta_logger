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
* Suspicious logins get `/auth_platform/recaptcha/`: a `www.fbsbx.com/captcha/recaptcha/iframe/` frame that embeds
  Google reCAPTCHA Enterprise (`www.google.com/recaptcha/enterprise/…` frames, `www.gstatic.com/recaptcha/` script).
  The URL policy allows those paths only (seen on the first real login, 2026-10-18). reCAPTCHA also needs its
  third-party cookie (`_GRECAPTCHA` on google.com): blocked, the solved captcha is rejected and the tab lands on
  `/accounts/login/` again. `CookiesAllowedForUrls` allows Google/Meta cookies under `https://www.instagram.com` only.
* The login form sends `useCDSWebLoginMutation`; a distrusted browser gets `caa_login_web {error_code: 1348009,
  recaptcha_needed: true, redirect_uri: /auth_platform/, ig_authenticated: false}` (Meta's "anti-scripting" check,
  `xfb_auth_platform_anti_scripting_content`). Solving the captcha (`AuthPlatformReCaptchaSubmitCaptchaMutation` →
  `{is_success: true, redirect_uri: /direct/inbox/}`) does not log in: the redirect (`?__coig_login=…&e=…`) lands on
  `/accounts/login/` and the next login asks again. With no debugger attached, WebGL and a matching time zone it still
  looped for the owner's account (2026-10-18), so the app offers logging in with a session from the owner's own
  browser (`POST /api/ig/session`). Login cookies to carry over: `sessionid` (`<user id>%3A…`, HttpOnly),
  `ds_user_id`, `csrftoken`, and the device cookies `mid`, `ig_did`, `datr`.
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
| PolarisDirectInboxQuery | 27909866362025854 (2026-10-18; was 27262915580045003) | `device_id_for_iris_subscription` + relay providers | `get_slide_mailbox_for_iris_subscription {id, threads_by_folder, pinned_threads_v2}` |
| IGDThreadListOffMsysPaginationQuery | 28774058922187457 (2026-10-18; was 27712934271665380) | `count, cursor, folder: INBOX, id: <viewer messaging id>` | `fetch__SlideMailbox.threads_by_folder` |
| IGDThreadDetailQuery | 39768212509458705 (2026-10-18; was 37117700834487428) | `thread_fbid`, `min_uq_seq_id: null`, page count 20 | `get_slide_thread_nullable.as_ig_direct_thread` |
| IGDMessageListOffMsysQuery | 28309970012037685 (2026-10-18; was 27502152406082940) | `id, first: 20, after` or `older_than_message_id` | `fetch__SlideThread.as_ig_direct_thread.slide_messages` |
| IGDirectTextSendMutation | 26911679871773184 | `ig_thread_igid, offline_threading_id, text.sensitive_string_value, reply_to_message_id, send_attribution` | `xig_direct_text_send_with_slide_messaging_response {message_id}` |
| IGDirectMediaSendMutation | 25766288509716264 | `attachment_fbid, thread_id, offline_threading_id, reply_to_message_id` | `xig_direct_media_send_with_slide_messaging_response` |
| IGDirectReactionSendMutation | 24374451552236906 | `input {emoji, item_id:'', message_id, reaction_status: created/deleted, thread_id}` | |
| IGDirectEditMessageMutation | 32480262318254796 | `thread_id, target_message_id, body.sensitive_string_value, offline_threading_id` | |
| IGDMessageUnsendDialogOffMsysMutation | 26948700068153789 | `message_id, send_data.thread_id` (**long** thread id) | `direct_unsend_message` |
| useIGDMarkThreadAsReadMutation | 27399783383056109 (2026-10-18; was 27356881703909995) | `metadata.ig_thread_igid` (long id), `data {message_id, item_id:''}` | |

Doc ids change with Instagram Web builds; the app learns the current ones from the tab's own requests (`docs.ts`).

Uploads: multipart `farr` (+ `voice_clip=true`) to `/ajax/mercury/upload.php?<common params>`; the answer's
`payload.metadata` holds `image_id` / `video_id` / `audio_id` / `gif_id` / `file_id` (bare numbers above 2^53).

## First live check (to do with the owner's account)

1. Log in through the Instagram screen; the state must reach `ready` and the history import must show chats.
2. Receive a message from another account; it must appear live. Unsend it; it must stay with the red "Unsent" badge.
3. Send a text, a reply, a reaction, a photo and a voice message from insta_logger; check them in the Instagram app.
4. `docker compose logs app | grep -i 'failed\|error'` — GraphQL errors name the query (never content).
5. If something fails, compare the tab's real requests (Settings → Instagram shows the last live update time).

## Reels (the Reels section)

* `PolarisClipsTabDesktopPaginationQuery` (doc 28198345703199479, 2026-10-18), variables as Instagram Web's /reels/
  page sends them: `{after, before: null, data: {container_module: "clips_tab_desktop_page", seen_reels:
  "[{\"id\":\"<pk>\"}]"}, first: 10, last: null}` + relay providers `PolarisReelsRecoDebugOverlayEnabled: false,
  PolarisThreadsStyleCommentsEnabled: false, PolarisShortDramaEnabled: true`. `after: null` gives the first page.
* Answer: `xdt_api__v1__clips__home__connection_v2 {edges[].node.media, page_info {end_cursor, has_next_page}}`; the
  media is the usual XDT media dict (`pk`, `code`, `user`, `caption.text`, `like_count`, `comment_count`,
  `video_versions[] {url, width, height}` progressive MP4, `image_versions2.candidates[]`).
* A reel link sent as DM text (`https://www.instagram.com/reel/<code>/`) shows as a reel card in Instagram.
* Comments: `GET /api/v1/media/<pk>/comments/?can_support_threading=true&permalink_enabled=false[&min_id=<next_min_id>]`
  (checked live 2026-10-18); comments carry `preview_child_comments` (first replies) and `child_comment_count`.
* The old REST writes (`/api/v1/web/likes/<pk>/like/`, `/api/v1/web/comments/<pk>/add/`) are refused now. Instagram
  Web's own mutations (captured 2026-10-18 by clicking in a second tab with `Fetch.failRequest`, so nothing was sent):
  `usePolarisLikeMediaXIGLikeMutation` 27182485238052618 / `usePolarisLikeMediaXIGUnlikeMutation` 27345296031770102:
  `{input: {actor_id: <viewer Meta id, 1784…>, client_mutation_id: "1", container_module: "reels_tab", media_id,
  tracking_token: <media.organic_tracking_token>}}`. `PolarisPostCommentInputRevampedMutation` 27261905640092552:
  `{connections: [<Relay key>], data: {comment_text, media_id, replied_to_comment_id?}}`; a reply's text starts with
  `@<username> ` and its connection is the parent's `child_comments` key. Comment like/unlike:
  `usePolarisCommentLikeMutation` 25746541371686622 `{input: {actor_id, client_mutation_id, comment_id}}` (not used).
* 2026-10-18: Instagram dropped the `PolarisAIGMAccountLabelEnabled` relay provider from the inbox and thread queries;
  with it (and the old inbox doc id) the inbox answered `{mailbox: null, errors: [1675030 field_exception]}`, which the
  first import took for an empty inbox. Now a null mailbox is an error, and an import that found no chats runs again.

## Stories (story logging)

* Stories bar: `GET /api/v1/feed/reels_tray/` → `tray[] {id, reel_type ('user_reel' | live…), latest_reel_media (s),
  seen, user {pk, username, full_name, profile_pic_url}}` (checked live 2026-10-18).
* Items: `PolarisStoriesV3ReelPageStandaloneQuery` (doc 28449850404637481) `{reel_ids_arr: [<user id>, …],
  __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true}` (the provider is required since
  2026-10-19; without it items are empty with `missing_required_variable_value`) →
  `xdt_api__v1__feed__reels_media.reels_media[] {id, user, items[] {pk, taken_at, expiring_at, media_type 1|2,
  image_versions2.candidates[], video_versions[]}}`; the answer also carries non-fatal `errors` (missing relay
  providers) next to the data. Reading items does not mark them as seen (`PolarisStoriesV3SeenMutation` / `PolarisAPIReelSeenMutation` do; never sent).
* Instagram's own viewer uses `PolarisStoriesV3ReelPageGalleryQuery` (doc 29306733562261201) `{initial_reel_id,
  reel_ids, first: 3, last: 2, + the provider}` and `…GalleryPaginationQuery` (doc 28597075096591838).
