import { CryptoError, ctEqual, generateX25519, hkdf, hmacSha256, openGcm, randomBytes, sealGcm, x25519PrivateKeyObject, x25519Shared } from '../crypto/primitives.js';

/*
 * Session sync between two insta_loggers (e.g. a homelab that can log in to Instagram and a VPS whose datacenter IP
 * Instagram won't show the login form): the "home" makes a separate Instagram session and hands it to the "remote".
 *
 * Pairing: the home creates a pairing code `igls1.<tenant>.<pairId>.<secret>` (secret = 32 random bytes, shown once);
 * the owner pastes it on the remote. The secret never crosses the wire again:
 *  - Request (remote → home, `GET /api/sync/session`): header `X-Session-Sync: v1.<pairId>.<ts>.<nonce>.<pub>.<mac>`,
 *    mac = HMAC-SHA256(K_auth, "igl-sync/v1|<pairId>|<ts>|<nonce>|<pub>"). The home accepts it within ±2 min and once
 *    per nonce. `pub` is the remote's one-off X25519 key for this fetch.
 *  - Answer: the cookies sealed with AES-256-GCM under HKDF(X25519(home one-off, pub) ‖ K_box), AAD = pairId|pub. Only
 *    the paired remote can open it (it needs K_box and its private key), and only the paired home can make it, so a
 *    path in between (the tunnel, the LAN's plain HTTP) sees neither the session nor anything it could replay.
 * K_auth and K_box are HKDF expansions of the secret.
 */

export const CODE_PREFIX = 'igls1';
export const HEADER = 'x-session-sync';
/** How far the remote's clock may be off. */
export const MAX_SKEW_MS = 2 * 60_000;

export interface Pairing {
  tenant: number;
  pairId: string;
  secret: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function newPairing(tenant: number): Pairing {
  return { tenant, pairId: randomBytes(8).toString('hex'), secret: randomBytes(32) };
}

export function pairingCode(p: Pairing): string {
  return `${CODE_PREFIX}.${p.tenant}.${p.pairId}.${p.secret.toString('base64url')}`;
}

/** Parses a pasted pairing code (whitespace around it is ignored). Null when it isn't one. */
export function parsePairingCode(code: string): Pairing | null {
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== CODE_PREFIX) return null;
  const [, t, pairId, s] = parts as [string, string, string, string];
  if (!/^\d{1,6}$/.test(t) || !/^[0-9a-f]{16}$/.test(pairId) || !B64URL.test(s)) return null;
  const secret = Buffer.from(s, 'base64url');
  if (secret.length !== 32) return null;
  const tenant = Number(t);
  return tenant >= 1 ? { tenant, pairId, secret } : null;
}

const authKey = (secret: Buffer) => hkdf(secret, Buffer.alloc(0), 'igl-sync/v1/auth');
const boxKey = (secret: Buffer) => hkdf(secret, Buffer.alloc(0), 'igl-sync/v1/box');
const macInput = (pairId: string, ts: number, nonce: string, pub: string) => `igl-sync/v1|${pairId}|${ts}|${nonce}|${pub}`;

/** The remote's request header for one fetch (a fresh nonce every call; the same `pub` while it waits for the home). */
export function signRequest(p: Pairing, pub: Buffer, now = Date.now()): string {
  const nonce = randomBytes(16).toString('base64url');
  const pubS = pub.toString('base64url');
  const mac = hmacSha256(authKey(p.secret), macInput(p.pairId, now, nonce, pubS)).toString('base64url');
  return `v1.${p.pairId}.${now}.${nonce}.${pubS}.${mac}`;
}

export interface SignedRequest {
  pairId: string;
  ts: number;
  nonce: string;
  pub: Buffer;
  mac: Buffer;
}

/** Splits the header (shape only; verifyRequest checks the mac). */
export function parseRequest(header: string | undefined): SignedRequest | null {
  if (typeof header !== 'string' || header.length > 300) return null;
  const parts = header.split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') return null;
  const [, pairId, ts, nonce, pub, mac] = parts as [string, string, string, string, string, string];
  if (!/^[0-9a-f]{16}$/.test(pairId) || !/^\d{1,15}$/.test(ts) || !B64URL.test(nonce) || !B64URL.test(pub) || !B64URL.test(mac)) return null;
  const pubB = Buffer.from(pub, 'base64url');
  const macB = Buffer.from(mac, 'base64url');
  if (nonce.length !== 22 || pubB.length !== 32 || macB.length !== 32) return null;
  return { pairId, ts: Number(ts), nonce, pub: pubB, mac: macB };
}

/** Whether [r] was signed with the pairing's secret, recently. (Replays are the caller's NonceCache's business.) */
export function verifyRequest(r: SignedRequest, p: { pairId: string; secret: Buffer }, now = Date.now()): boolean {
  if (Math.abs(now - r.ts) > MAX_SKEW_MS) return false;
  const expect = hmacSha256(authKey(p.secret), macInput(p.pairId, r.ts, r.nonce, r.pub.toString('base64url')));
  // Compared even for a foreign pairId, so a wrong id costs the same as a wrong mac.
  return ctEqual(expect, r.mac) && ctEqual(r.pairId, p.pairId);
}

/** Remembers nonces for the skew window: each signed request is accepted once. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 2 * MAX_SKEW_MS + 10_000) {}

  /** True the first time [nonce] is seen within the window. */
  use(nonce: string, now = Date.now()): boolean {
    for (const [n, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= 10_000) return false; // flood: refuse rather than grow
    this.seen.set(nonce, now);
    return true;
  }
}

const boxAad = (pairId: string, pub: Buffer) => `igl-sync/v1|box|${pairId}|${pub.toString('base64url')}`;

function sessionKey(shared: Buffer, secret: Buffer, pairId: string): Buffer {
  return hkdf(Buffer.concat([shared, boxKey(secret)]), Buffer.alloc(0), `igl-sync/v1/session|${pairId}`);
}

/** Home: seals [payload] for the remote's one-off key [pub]. Output (base64url): home one-off pub(32) ‖ GCM box. */
export function sealForRemote(p: { pairId: string; secret: Buffer }, pub: Buffer, payload: Buffer): string {
  const eph = generateX25519();
  const key = sessionKey(x25519Shared(x25519PrivateKeyObject(eph.privatePkcs8), pub), p.secret, p.pairId);
  return Buffer.concat([eph.publicRaw, sealGcm(key, payload, boxAad(p.pairId, pub))]).toString('base64url');
}

/** Remote: opens the home's answer with its one-off key pair. Throws CryptoError when it wasn't made for it. */
export function openFromHome(p: Pairing, mine: { publicRaw: Buffer; privatePkcs8: Buffer }, box: string): Buffer {
  if (!B64URL.test(box)) throw new CryptoError('bad box');
  const raw = Buffer.from(box, 'base64url');
  if (raw.length < 32 + 28) throw new CryptoError('bad box');
  const key = sessionKey(x25519Shared(x25519PrivateKeyObject(mine.privatePkcs8), raw.subarray(0, 32)), p.secret, p.pairId);
  return openGcm(key, raw.subarray(32), boxAad(p.pairId, mine.publicRaw));
}
