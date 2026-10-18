/**
 * GraphQL document ids of Instagram Web's direct-message queries and mutations. Instagram changes them when it ships
 * a new web build. The defaults come from mautrix-meta (`pkg/messagix/graphql/docs.go`, 2026-10); every time the
 * Instagram tab itself sends one of these requests, capture.ts learns the current id and it is used from then on
 * (persisted in app_state, so a restart keeps it).
 */
export const DEFAULT_DOC_IDS: Record<string, string> = {
  PolarisDirectInboxQuery: '27262915580045003',
  IGDThreadListOffMsysPaginationQuery: '27712934271665380',
  IGDThreadDetailQuery: '37117700834487428',
  IGDMessageListOffMsysQuery: '27502152406082940',
  IGDirectTextSendMutation: '26911679871773184',
  IGDirectMediaSendMutation: '25766288509716264',
  IGDirectEditMessageMutation: '32480262318254796',
  IGDMessageUnsendDialogOffMsysMutation: '26948700068153789',
  IGDirectReactionSendMutation: '24374451552236906',
  useIGDMarkThreadAsReadMutation: '27356881703909995',
  // The Reels section (igweb/): read from Instagram Web's own requests, 2026-10-18.
  PolarisClipsTabDesktopPaginationQuery: '28198345703199479',
};

export type QueryName = keyof typeof DEFAULT_DOC_IDS;

const STATE_KEY = 'ig_doc_ids';

export class DocIds {
  private learned = new Map<string, string>();

  constructor(private readonly store: { get(key: string): string | undefined; set(key: string, value: string): void }) {
    try {
      const raw = store.get(STATE_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) if (typeof v === 'string' && /^\d{6,24}$/.test(v)) this.learned.set(k, v);
    } catch {
      /* ignore a broken entry */
    }
  }

  get(name: string): string | null {
    return this.learned.get(name) ?? DEFAULT_DOC_IDS[name] ?? null;
  }

  /** Called with every GraphQL request the Instagram tab sends. Returns true when an id changed. */
  learn(name: string, docId: string): boolean {
    if (!(name in DEFAULT_DOC_IDS) || !/^\d{6,24}$/.test(docId) || this.get(name) === docId) return false;
    this.learned.set(name, docId);
    this.store.set(STATE_KEY, JSON.stringify(Object.fromEntries(this.learned)));
    return true;
  }
}
