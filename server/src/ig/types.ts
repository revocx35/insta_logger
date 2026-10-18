/**
 * The parts of Instagram Web's "Slide" messaging JSON that insta_logger reads. Field names follow Instagram
 * (documented by mautrix-meta `pkg/instameow/slidetypes`). Everything is optional: Instagram changes shapes
 * without notice, so the mapper checks every field it uses.
 */

export interface IgUser {
  id?: string; // Instagram user id (pk)
  pk?: string;
  interop_messaging_user_fbid?: string | number;
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
  is_verified?: boolean;
}

export interface IgAttachment {
  __typename?: string;
  attachment_fbid?: string;
  attachment_type?: number;
  attachment_cdn_url?: string;
  attachment_cdn_fallback_url?: string;
  preview_cdn_url?: string;
  preview_height?: number;
  preview_width?: number;
  dash_manifest?: string;
  // audio
  playable_duration_ms?: number;
  // animated media
  attachment_webp_url?: string;
  attachment_mp4_url?: string;
  is_sticker?: boolean;
  alt_text?: string;
  // video metadata sometimes present
  original_width?: number;
  original_height?: number;
  playable_duration_in_ms?: number;
}

export interface IgXma {
  __typename?: string;
  xmaHeaderTitle?: unknown;
  xmaTitle?: string;
  xmaPreviewImage?: { url?: string; width?: number; height?: number } | null;
  title_text?: string;
  header_title_text?: string;
  header_subtitle_text?: string;
  subtitle_text?: string;
  caption_body_text?: string;
  preview_image?: { url?: string; fallback_url?: string; width?: number; height?: number } | null;
  target_id?: string;
  target_url?: string;
  eyebrow_text?: string;
}

export interface IgContent {
  __typename?: string;
  text_body?: string;
  // admin text
  text_fragments?: { plaintext?: string }[];
  // media
  attachments?: IgAttachment[];
  videos?: IgAttachment[];
  ordered_photo_video_attachments?: IgAttachment[];
  audio_attachments?: IgAttachment[];
  animated_media?: IgAttachment[];
  // raven (view once)
  view_mode?: number;
  attachment?: IgAttachment | null;
  // sticker
  alt_text?: string;
  preview_url?: string;
  preview_height?: number;
  preview_width?: number;
  // xma
  xma?: IgXma | null;
  xma_text_body?: string;
  // music sticker
  audio_track?: { web_30s_preview_download_url?: string; title?: string; display_artist?: string };
  // AI responses
  unified_response?: string;
  messasge_text_body?: string;
}

export interface IgReaction {
  reaction?: string;
  reaction_timestamp_ms?: string | number;
  sender_fbid?: string | number;
  log_message_id?: string;
}

export interface IgMention {
  offset?: number;
  length?: number;
  profile_range_type?: string;
  user_fbid?: string | number;
}

export interface IgMessage {
  __typename?: string;
  id?: string;
  message_id?: string;
  sender_fbid?: string | number;
  thread_fbid?: string;
  content?: IgContent | null;
  content_type?: string;
  offline_threading_id?: string;
  timestamp_ms?: string | number;
  reactions?: IgReaction[] | null;
  text_body?: string;
  mentions?: IgMention[] | null;
  igd_is_forwarded?: boolean;
  igd_snippet?: string;
  replied_to_message_id?: string;
  replied_to_message?: IgMessage | null;
  sender?: { name?: string; id?: string; igid?: string; user_dict?: IgUser | null } | null;
  slide_edit_history?: { body?: string; timestamp_ms?: string | number }[] | null;
  expiration_timestamp_ms?: string | number | null;
  view_expiration_timestamp_ms?: string | number | null;
  is_reported?: boolean;
}

export interface IgThread {
  id?: string;
  thread_key?: string | number;
  thread_fbid?: string;
  thread_subtype?: string;
  thread_id?: string;
  is_group?: boolean;
  viewer_id?: string;
  viewer?: IgUser | null;
  thread_title?: string;
  thread_image_url?: string;
  users?: IgUser[] | null;
  last_activity_timestamp_ms?: string | number;
  slide_messages?: IgEdged<IgMessage> | null;
  slide_read_receipts?: { participant_fbid?: string | number; watermark_timestamp_ms?: string | number }[] | null;
  marked_as_unread?: boolean;
  is_muted?: boolean | null;
  is_pin?: boolean | null;
  folder?: string;
  system_folder?: string;
  messaging_folder_tag?: string;
}

export interface IgEdged<T> {
  edges?: { node?: T | null; cursor?: string }[] | null;
  page_info?: { end_cursor?: string; has_next_page?: boolean; start_cursor?: string; has_previous_page?: boolean } | null;
}
