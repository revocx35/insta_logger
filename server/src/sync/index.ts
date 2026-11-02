import type { AppContext } from '../context.js';
import { SyncHome } from './home.js';
import { SyncRemote } from './remote.js';
import { SealedState } from './store.js';

/** Session sync of this tenant: the giving side (home) and the receiving side (remote); either or both may be set up. */
export class SessionSync {
  readonly home: SyncHome;
  readonly remote: SyncRemote;

  constructor(ctx: AppContext) {
    const store = new SealedState(ctx.repo, ctx.config.dataDir);
    this.home = new SyncHome(ctx, store, {
      separateLogin: (device) => ctx.ig.separateLogin(device),
      passwordSaved: () => ctx.ig.autoLoginStatus().saved,
    });
    this.remote = new SyncRemote(ctx, store, { importSession: (cookies) => ctx.ig.importSession(cookies) });
  }
}
