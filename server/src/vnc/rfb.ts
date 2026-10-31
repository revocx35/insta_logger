import type { Duplex } from 'node:stream';
import { vncAuthResponse } from './des.js';

/*
 * A minimal RFB (VNC) client that only sends input: pointer and key events into the tenant's virtual screen, through
 * the same x11vnc the owner uses from the browser. x11vnc turns them into X input (XTEST), so the page sees ordinary
 * trusted mouse and keyboard events and nothing is attached to the tab (ig/autologin.ts).
 * It never asks for screen updates; whatever the server sends anyway is drained and ignored.
 */

const TIMEOUT_MS = 10_000;
const SEC_NONE = 1;
const SEC_VNC = 2;

/** Reads exact byte counts from a stream (the handshake is a strict request/answer sequence). */
class Reader {
  private buf = Buffer.alloc(0);
  private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;

  constructor(stream: Duplex) {
    stream.on('data', (d: Buffer) => {
      // After the handshake nothing is read any more: keep no more than a little of what the server sends.
      this.buf = this.waiting || this.buf.length < 64 * 1024 ? Buffer.concat([this.buf, d]) : this.buf;
      this.flush();
    });
    const end = (e: Error) => {
      this.ended = e;
      this.waiting?.reject(e);
      this.waiting = null;
    };
    stream.on('end', () => end(new Error('VNC connection closed')));
    stream.on('close', () => end(new Error('VNC connection closed')));
    stream.on('error', () => end(new Error('VNC connection failed')));
  }

  private flush(): void {
    if (!this.waiting || this.buf.length < this.waiting.n) return;
    const w = this.waiting;
    this.waiting = null;
    const out = this.buf.subarray(0, w.n);
    this.buf = this.buf.subarray(w.n);
    w.resolve(Buffer.from(out));
  }

  read(n: number): Promise<Buffer> {
    if (this.ended && this.buf.length < n) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = null;
        reject(new Error('VNC handshake timed out'));
      }, TIMEOUT_MS);
      this.waiting = {
        n,
        resolve: (b) => {
          clearTimeout(t);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.flush();
    });
  }

  /** Stops buffering: everything the server sends from now on is dropped. */
  drain(): void {
    this.buf = Buffer.alloc(0);
  }
}

export class RfbInput {
  private buttons = 0;

  private constructor(
    private readonly stream: Duplex,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Runs the RFB 3.7/3.8 handshake (VNC authentication with [password]) and returns a client ready for input. */
  static async connect(stream: Duplex, password: string): Promise<RfbInput> {
    // Every 6-byte pointer event must leave at once: with Nagle's algorithm they waited for delayed ACKs and reached
    // the screen in ~250 ms bursts, which Chromium merged into a few jumps.
    (stream as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    const r = new Reader(stream);
    try {
      const version = (await r.read(12)).toString('latin1');
      const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
      if (!m || Number(m[1]) !== 3 || Number(m[2]) < 7) throw new Error('unsupported VNC server');
      const minor = Number(m[2]) >= 8 ? 8 : 7;
      stream.write(`RFB 003.00${minor}\n`);
      const count = (await r.read(1))[0]!;
      if (count === 0) throw new Error('VNC server refused the connection');
      const types = [...(await r.read(count))];
      const type = types.includes(SEC_VNC) ? SEC_VNC : types.includes(SEC_NONE) ? SEC_NONE : 0;
      if (!type) throw new Error('no supported VNC security type');
      stream.write(Buffer.from([type]));
      if (type === SEC_VNC) stream.write(vncAuthResponse(password, await r.read(16)));
      if (type === SEC_VNC || minor === 8) {
        const result = (await r.read(4)).readUInt32BE(0);
        if (result !== 0) throw new Error('VNC authentication failed');
      }
      stream.write(Buffer.from([1])); // ClientInit: shared, the owner's own viewer stays connected
      const init = await r.read(24);
      const width = init.readUInt16BE(0);
      const height = init.readUInt16BE(2);
      await r.read(init.readUInt32BE(20)); // desktop name
      r.drain();
      return new RfbInput(stream, width, height);
    } catch (err) {
      stream.destroy();
      throw err;
    }
  }

  private send(b: Buffer): void {
    if (this.stream.destroyed) throw new Error('VNC connection closed');
    this.stream.write(b);
  }

  /** PointerEvent: moves the pointer to (x, y) with the current button state. */
  move(x: number, y: number): void {
    this.pointer(x, y, this.buttons);
  }

  /** Presses (down) or releases button 1 (left) at (x, y). */
  button(x: number, y: number, down: boolean): void {
    this.buttons = down ? this.buttons | 1 : this.buttons & ~1;
    this.pointer(x, y, this.buttons);
  }

  private pointer(x: number, y: number, mask: number): void {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    b.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.send(b);
  }

  /** KeyEvent with an X keysym. */
  key(keysym: number, down: boolean): void {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.send(b);
  }

  close(): void {
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 500).unref();
  }
}
