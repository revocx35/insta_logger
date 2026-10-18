/**
 * GraphQL document ids of Instagram Web's direct-message queries and mutations. Instagram changes them when it ships
 * a new web build. The defaults come from mautrix-meta (`pkg/messagix/graphql/docs.go`, 2026-10); every time the
 * Instagram tab itself sends one of these requests, capture.ts learns the current id and it is used from then on
 * (persisted in app_state, so a restart keeps it).
 */
export const DEFAULT_DOC_IDS: Record<string, string> = {
  PolarisDirectInboxQuery: '27909866362025854',
  IGDThreadListOffMsysPaginationQuery: '28774058922187457',
  IGDThreadDetailQuery: '39768212509458705',
  IGDMessageListOffMsysQuery: '28309970012037685',
  IGDirectTextSendMutation: '26911679871773184',
  IGDirectMediaSendMutation: '25766288509716264',
  IGDirectEditMessageMutation: '32480262318254796',
  IGDMessageUnsendDialogOffMsysMutation: '26948700068153789',
  IGDirectReactionSendMutation: '24374451552236906',
  useIGDMarkThreadAsReadMutation: '27399783383056109',
  // The Reels section (igweb/): read from Instagram Web's own requests, 2026-10-18.
  PolarisClipsTabDesktopPaginationQuery: '28198345703199479',
  // Story logging (ig/stories.ts): the stories viewer's query, 2026-10-18.
  PolarisStoriesV3ReelPageStandaloneQuery: '28449850404637481',
  usePolarisLikeMediaXIGLikeMutation: '27182485238052618',
  usePolarisLikeMediaXIGUnlikeMutation: '27345296031770102',
  PolarisPostCommentInputRevampedMutation: '27261905640092552',
};

export type QueryName = keyof typeof DEFAULT_DOC_IDS;

const STATE_KEY = 'ig_doc_ids';

/**
 * Learned ids are stored with the default they replaced (`{id, base}`): when a newer insta_logger ships a different
 * default, an id learned against the old default is stale and dropped (it may no longer work at all).
 */
export class DocIds {
  private learned = new Map<string, { id: string; base: string | null }>();

  constructor(private readonly store: { get(key: string): string | undefined; set(key: string, value: string): void }) {
    try {
      const raw = store.get(STATE_KEY);
      if (raw) {
        for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          // Old format (plain id string) carries no base: treat it as learned against an older default.
          const e = typeof v === 'string' ? { id: v, base: null } : (v as { id?: unknown; base?: unknown });
          if (typeof e.id !== 'string' || !/^\d{6,24}$/.test(e.id)) continue;
          const base = typeof e.base === 'string' ? e.base : null;
          if (base !== (DEFAULT_DOC_IDS[k] ?? null)) continue;
          this.learned.set(k, { id: e.id, base });
        }
      }
    } catch {
      /* ignore a broken entry */
    }
  }

  get(name: string): string | null {
    return this.learned.get(name)?.id ?? DEFAULT_DOC_IDS[name] ?? null;
  }

  /** Called with every GraphQL request the Instagram tab sends. Returns true when an id changed. */
  learn(name: string, docId: string): boolean {
    if (!(name in DEFAULT_DOC_IDS) || !/^\d{6,24}$/.test(docId) || this.get(name) === docId) return false;
    this.learned.set(name, { id: docId, base: DEFAULT_DOC_IDS[name] ?? null });
    this.store.set(STATE_KEY, JSON.stringify(Object.fromEntries(this.learned)));
    return true;
  }
}
