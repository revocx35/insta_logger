import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '../db/repo.js';
import { openGcm, randomKey, sealGcm } from '../crypto/primitives.js';

/*
 * Secrets of session sync (the pairing secret, the remote's pairing code, device cookies) sealed in app_state under a
 * random key in `<DATA_DIR>/sync.key` (0600) — like the automatic login's password: the worker needs them with nobody
 * logged in, and a stolen database alone doesn't reveal them. Each entry is bound to its key name (AAD).
 */
export class SealedState {
  constructor(
    private readonly repo: Repo,
    private readonly dataDir: string,
  ) {}

  private get keyPath(): string {
    return path.join(this.dataDir, 'sync.key');
  }

  private key(create: boolean): Buffer | null {
    try {
      const k = fs.readFileSync(this.keyPath);
      if (k.length === 32) return k;
    } catch {
      /* not there yet */
    }
    if (!create) return null;
    const k = randomKey();
    fs.writeFileSync(this.keyPath, k, { mode: 0o600 });
    return k;
  }

  get<T>(name: string): T | null {
    const raw = this.repo.getState(name);
    const key = raw ? this.key(false) : null;
    if (!raw || !key) return null;
    try {
      return JSON.parse(openGcm(key, Buffer.from(raw, 'base64'), `igl/v1|app_state|${name}`).toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  set(name: string, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    this.repo.setState(name, sealGcm(this.key(true)!, body, `igl/v1|app_state|${name}`).toString('base64'));
    body.fill(0);
  }

  delete(name: string): void {
    this.repo.deleteState(name);
  }

  /** Plain (not secret) JSON next to the sealed entries: status lines. */
  getPlain<T>(name: string, fallback: T): T {
    try {
      const raw = this.repo.getState(name);
      return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
    } catch {
      return fallback;
    }
  }

  setPlain(name: string, value: unknown): void {
    this.repo.setState(name, JSON.stringify(value));
  }
}
