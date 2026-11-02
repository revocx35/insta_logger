import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SyncPairing, SyncRemoteRun } from '../../../shared/api.js';
import { verifyOwnerSecret } from '../auth/routes.js';
import { sessionPrivateKey } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { PASSWORD_MAX } from '../crypto/password.js';
import { AppError, Errors } from '../errors.js';
import { requireSession } from '../http/server.js';
import { HEADER, parsePairingCode } from '../sync/protocol.js';
import { normalizeHomeUrl, URL_MAX } from '../sync/remote.js';
import type { SessionSync } from '../sync/index.js';

/*
 * Session sync (sync/): the owner's settings for both sides, and the one machine route the paired remote calls.
 * The pairing secret and code are credentials: never logged, the code is shown once and is write-only on the remote.
 */
export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext, sync: SessionSync): void {
  const { repo } = ctx;

  /* ------------------------------------------------------- giving side */
  app.get('/api/sync/home', async () => sync.home.status());

  // A pairing code lets its holder obtain Instagram sessions of this account: the password (and 2FA) again.
  app.post('/api/sync/home/pair', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const s = requireSession(req);
    const { password, totp } = z.object({ password: z.string().min(1).max(PASSWORD_MAX), totp: z.string().max(12).optional() }).strict().parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    const check = await verifyOwnerSecret(ctx, req, owner, password, totp, () => sessionPrivateKey(s));
    check.kek?.fill(0);
    if (!check.ok) {
      repo.audit('sync_pair_failed', req.ip);
      throw new AppError(401, 'invalid_password', owner.totp_enabled ? 'Invalid password or authentication code.' : 'Password is incorrect.');
    }
    const res: SyncPairing = { code: sync.home.createPairing() };
    repo.audit('sync_paired', req.ip);
    return res;
  });

  app.post('/api/sync/home/resume', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    sync.home.resume();
    repo.audit('sync_home_resumed', req.ip);
    return sync.home.status();
  });

  app.delete('/api/sync/home', async (req) => {
    sync.home.removePairing();
    repo.audit('sync_unpaired', req.ip);
    return sync.home.status();
  });

  // The paired remote: signed with X-Session-Sync (sync/protocol.ts), no session or cookie of this app. A GET, so no
  // Origin/CSRF check applies; the signature (HMAC, ±2 min, one use per nonce) is the authentication.
  app.get('/api/sync/session', { config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const header = req.headers[HEADER];
    const a = sync.home.handle(Array.isArray(header) ? undefined : header);
    reply.header('Cache-Control', 'no-store');
    if ('body' in a) return reply.code(a.status).send(a.body);
    if (a.retryMs !== undefined) reply.header('Retry-After', String(Math.ceil(a.retryMs / 1000)));
    return reply.code(a.status).send({ error: { code: a.code, message: a.message }, ...(a.retryMs !== undefined ? { retryMs: a.retryMs } : {}) });
  });

  /* ---------------------------------------------------- receiving side */
  app.get('/api/sync/remote', async () => sync.remote.status());

  app.put('/api/sync/remote', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = z.object({ url: z.string().max(URL_MAX).optional(), code: z.string().max(200).optional(), enabled: z.boolean().optional() }).strict().parse(req.body);
    const pairing = body.url !== undefined || body.code !== undefined;
    if (pairing) {
      if (body.url === undefined || !normalizeHomeUrl(body.url)) throw new AppError(400, 'invalid_url', 'Enter the home insta_logger address, e.g. http://10.0.0.2:8091');
      if (body.code === undefined || !parsePairingCode(body.code)) throw new AppError(400, 'invalid_code', 'Paste the pairing code from the home insta_logger.');
    } else if (!sync.remote.status().configured) {
      throw new AppError(400, 'not_saved', 'Save the home address and pairing code first.');
    }
    sync.remote.save(body);
    repo.audit(pairing ? 'sync_remote_saved' : 'sync_remote_changed', req.ip, body.enabled === undefined ? null : `enabled=${body.enabled}`);
    return sync.remote.status();
  });

  app.delete('/api/sync/remote', async (req) => {
    sync.remote.remove();
    repo.audit('sync_remote_deleted', req.ip);
    return sync.remote.status();
  });

  app.post('/api/sync/remote/run', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const look = await ctx.ig.loggedOutLook().catch(() => null);
    const res: SyncRemoteRun = { result: look ? sync.remote.runNow(look) : 'not_on_login_page' };
    repo.audit('sync_remote_run', req.ip, res.result);
    return res;
  });
}
