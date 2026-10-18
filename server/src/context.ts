import type { IgStatus, SendMediaKind, SendResult, StoryStatus } from '../../shared/api.js';
import type { Config } from './config.js';
import type { SessionCookie } from './ig/cookies.js';
import type { Downloader } from './ig/media.js';
import { Errors } from './errors.js';
import { DataWriter } from './crypto/keyring.js';
import type { Repo } from './db/repo.js';
import { Throttle } from './auth/throttle.js';
import type { EventBus } from './events.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';

/** Sending as the logged-in account (throws AppError: unavailable when Instagram is not connected). */
export interface IgSender {
  sendText(chatId: string, text: string, quotedId: string | null): Promise<SendResult>;
  sendMedia(chatId: string, file: { data: Buffer; mime: string; filename: string | null }, kind: SendMediaKind, quotedId: string | null): Promise<SendResult>;
  /** An empty emoji removes the owner's reaction ([previous]: the emoji being removed, Instagram needs it). */
  react(messageId: string, emoji: string, previous?: string | null): Promise<void>;
  /** Unsend (removes the message for everyone). */
  unsend(messageId: string): Promise<void>;
  edit(messageId: string, text: string): Promise<void>;
  markRead(chatId: string): Promise<void>;
}

/** Control surface of the Instagram integration, used by the HTTP layer. */
/** What the Reels section (igweb/) needs from the live Instagram tab. */
export interface IgWebSource {
  graphql<T>(name: string, variables: unknown): Promise<T>;
  rest<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string> | null): Promise<T>;
  downloader: Downloader;
  /** The logged-in account's Instagram id. */
  meId: string | null;
  /** The logged-in account's Meta id ("actor" of likes). */
  meFbid: string | null;
}

export interface IgController {
  status(): IgStatus;
  /** Idempotent. Starts connecting to Chromium / Instagram. */
  start(): Promise<void>;
  /** Reconnects to Chromium and reloads the Instagram tab. */
  restart(): Promise<void>;
  /** Logs the Instagram tab out (the owner logs in again on the Instagram screen). */
  logout(): Promise<void>;
  /** Logs in with a session (cookies) from the owner's own browser, instead of the login form. */
  importSession(cookies: SessionCookie[]): Promise<void>;
  /** Story logging: status and "check now". */
  storyStatus(): StoryStatus;
  checkStoriesNow(): Promise<void>;
  /** The live tab for the Reels section; null unless Instagram is connected and logged in. */
  webSource(): IgWebSource | null;
  /** Re-queues a media download. Returns false if the message has no retryable media. */
  retryMedia(messageId: string): boolean;
  /** Called after all logged data was wiped (drop in-memory caches). */
  onDataWiped(): void;
  stop(): Promise<void>;
  readonly sender: IgSender;
}

export class AppContext {
  private writerInstance: DataWriter | null = null;
  ig: IgController;
  /** Every registered route (filled by an onRoute hook) — used by the auth coverage test. */
  readonly routeTable: { method: string; url: string; public: boolean }[] = [];
  /** Brute-force throttle shared by every credential check. */
  readonly throttle: Throttle;

  constructor(
    readonly config: Config,
    readonly log: Logger,
    readonly repo: Repo,
    readonly events: EventBus,
    readonly settings: SettingsStore,
    ig?: IgController,
  ) {
    this.ig = ig ?? new NullIg();
    this.throttle = new Throttle(repo);
  }

  /** The encryptor for new data; null until an owner (and thus a public key) exists. */
  writer(): DataWriter | null {
    if (this.writerInstance) return this.writerInstance;
    const owner = this.repo.getOwner();
    if (!owner) return null;
    this.writerInstance = new DataWriter(this.repo, owner.public_key);
    return this.writerInstance;
  }

  mediaMaxBytes(): number {
    return this.settings.get().mediaMaxMb * 1024 * 1024;
  }
}

const notConnected = async (): Promise<never> => {
  throw Errors.unavailable('Instagram is not connected.');
};

export class NullIg implements IgController {
  private readonly since = Date.now();
  readonly sender: IgSender = {
    sendText: notConnected,
    sendMedia: notConnected,
    react: notConnected,
    unsend: notConnected,
    edit: notConnected,
    markRead: notConnected,
  };
  status(): IgStatus {
    return { state: 'idle', mediaQueue: 0, since: this.since, sync: null, lastEventAt: null };
  }
  async start(): Promise<void> {}
  async restart(): Promise<void> {}
  async logout(): Promise<void> {}
  webSource(): IgWebSource | null {
    return null;
  }
  storyStatus(): StoryStatus {
    return { enabled: false, retentionDays: 30, stories: 0, lastCheckAt: null, nextCheckAt: null, lastResult: null };
  }
  async checkStoriesNow(): Promise<void> {
    throw Errors.unavailable('Instagram is not enabled.');
  }
  async importSession(_cookies: SessionCookie[]): Promise<void> {
    throw Errors.unavailable('Instagram is not enabled.');
  }
  retryMedia(): boolean {
    return false;
  }
  onDataWiped(): void {}
  async stop(): Promise<void> {}
}
