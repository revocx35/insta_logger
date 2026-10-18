/**
 * Decoding of Instagram Web's direct-message stream as it crosses the browser's WebSocket
 * (`wss://gateway.instagram.com/ws/lightspeed`), read passively over CDP (see capture.ts).
 *
 * Layers (format documented by the mautrix-meta project, `pkg/messagix/dgw` and `pkg/instameow`):
 *   WebSocket binary message → one or more DGW frames (type byte, little-endian lengths)
 *   → data frame payload = JSON `{"request_id":…, "payload":"<base64>"}`
 *   → protobuf `LSResponse { repeated Operation operations = 2 }`
 *   → `Operation.delta (3) = OnMailboxDelta { string delta = 2 }`
 *   → JSON `[{"data":{"slide_delta_processor":[Delta, …]}}]`.
 * Everything here is pure and defensive: malformed input yields nothing instead of throwing.
 */

export const enum FrameType {
  Drain = 3,
  Deauth = 4,
  Ping = 9,
  Pong = 10,
  Ack = 12,
  Data = 13,
  EndOfData = 14,
  EstabStream = 15,
  EndOfDataWithReason = 16,
  ExtendedData = 17,
}

export interface DataFrame {
  streamId: number;
  payload: Buffer;
}

const u24 = (b: Buffer, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

/** Splits a WebSocket message into DGW frames and returns the data frames' payloads. */
export function parseDataFrames(buf: Buffer): DataFrame[] {
  const out: DataFrame[] = [];
  let o = 0;
  while (o < buf.length) {
    const type = buf[o]!;
    switch (type) {
      case FrameType.Ping:
      case FrameType.Pong:
      case FrameType.Deauth:
        o += 1;
        continue;
      case FrameType.Drain: {
        if (o + 5 > buf.length) return out;
        o += 5;
        continue;
      }
      case FrameType.Data:
      case FrameType.ExtendedData: {
        if (o + 8 > buf.length) return out;
        const streamId = buf.readUInt16LE(o + 1);
        const length = u24(buf, o + 3);
        const header = type === FrameType.ExtendedData ? 9 : 8;
        const end = o + 6 + length;
        if (length < header - 6 || end > buf.length) return out;
        out.push({ streamId, payload: buf.subarray(o + header, end) });
        o = end;
        continue;
      }
      case FrameType.Ack: {
        // type, streamId u16, length u24 (= 2), ackId u16
        if (o + 6 > buf.length) return out;
        const length = u24(buf, o + 3);
        o += 6 + length;
        continue;
      }
      case FrameType.EstabStream:
      case FrameType.EndOfData:
      case FrameType.EndOfDataWithReason: {
        // type, streamId u16, length u24, body
        if (o + 6 > buf.length) return out;
        const length = u24(buf, o + 3);
        o += 6 + length;
        continue;
      }
      default:
        // Unknown frame type: the rest can't be framed reliably.
        return out;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- protobuf */

interface PbField {
  no: number;
  wire: number;
  value: bigint | Buffer;
}

function readVarint(b: Buffer, o: number): [bigint, number] | null {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (o >= b.length) return null;
    const byte = b[o++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, o];
    shift += 7n;
  }
  return null;
}

/** Minimal protobuf reader: top-level fields of one message (varint, 64-bit, length-delimited, 32-bit). */
export function pbFields(b: Buffer): PbField[] | null {
  const out: PbField[] = [];
  let o = 0;
  while (o < b.length) {
    const key = readVarint(b, o);
    if (!key) return null;
    o = key[1];
    const no = Number(key[0] >> 3n);
    const wire = Number(key[0] & 7n);
    if (no === 0) return null;
    if (wire === 0) {
      const v = readVarint(b, o);
      if (!v) return null;
      out.push({ no, wire, value: v[0] });
      o = v[1];
    } else if (wire === 1) {
      if (o + 8 > b.length) return null;
      out.push({ no, wire, value: b.subarray(o, o + 8) });
      o += 8;
    } else if (wire === 2) {
      const len = readVarint(b, o);
      if (!len) return null;
      o = len[1];
      const n = Number(len[0]);
      if (o + n > b.length) return null;
      out.push({ no, wire, value: b.subarray(o, o + n) });
      o += n;
    } else if (wire === 5) {
      if (o + 4 > b.length) return null;
      out.push({ no, wire, value: b.subarray(o, o + 4) });
      o += 4;
    } else {
      return null;
    }
  }
  return out;
}

export type LsOperation =
  | { kind: 'subscribe'; subscribedSeqId: number | null; latestSeqId: number | null }
  | { kind: 'resnapshot'; error: string | null }
  | { kind: 'delta'; delta: string }
  | { kind: 'noop' }
  | { kind: 'failure'; error: string | null };

const str = (v: bigint | Buffer | undefined) => (Buffer.isBuffer(v) ? v.toString('utf8') : null);
const num = (v: bigint | Buffer | undefined) => (typeof v === 'bigint' ? Number(v) : null);

/** Decodes `LSResponse` (MDCoreSync.proto). Returns null when the bytes are not one. */
export function decodeLsResponse(b: Buffer): LsOperation[] | null {
  const top = pbFields(b);
  if (!top) return null;
  const ops: LsOperation[] = [];
  for (const f of top) {
    if (f.no !== 2 || !Buffer.isBuffer(f.value)) continue;
    const opFields = pbFields(f.value);
    if (!opFields || opFields.length === 0) continue;
    const inner = opFields[0]!;
    const body = Buffer.isBuffer(inner.value) ? pbFields(inner.value) ?? [] : [];
    const get = (no: number) => body.find((x) => x.no === no)?.value;
    switch (inner.no) {
      case 1:
        ops.push({ kind: 'subscribe', subscribedSeqId: num(get(2)), latestSeqId: num(get(3)) });
        break;
      case 2:
        ops.push({ kind: 'resnapshot', error: str(get(2)) });
        break;
      case 3: {
        const delta = str(get(2));
        if (delta !== null) ops.push({ kind: 'delta', delta });
        break;
      }
      case 4:
        ops.push({ kind: 'noop' });
        break;
      case 5:
        ops.push({ kind: 'failure', error: str(get(2)) });
        break;
      default:
        break;
    }
  }
  return ops;
}

/* ------------------------------------------------------------------- deltas */

/** JSON.parse that keeps integers above 2^53 (Instagram ids) as their exact decimal string. */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source ? ctx.source : v,
  );
}

/** One mailbox change (`__typename` "SlideUQPP…"). Kept loosely typed: see types.ts for the fields used. */
export interface RawDelta {
  __typename?: string;
  uq_seq_id?: string;
  thread_fbid?: string;
  [k: string]: unknown;
}

export interface StreamEvents {
  deltas: RawDelta[];
  /** The stream (re)subscribed: Instagram Web is connected. */
  subscribed: boolean;
  /** Instagram asked the page to re-snapshot (deltas were lost): run a reconcile. */
  resnapshot: boolean;
}

/** Turns the base64 `payload` of a data frame's JSON envelope into deltas. */
export function decodeDataPayload(payload: Buffer, ev: StreamEvents): boolean {
  if (payload.length < 2 || payload[0] !== 0x7b /* { */) return false;
  let env: { payload?: unknown };
  try {
    env = JSON.parse(payload.toString('utf8')) as { payload?: unknown };
  } catch {
    return false;
  }
  if (typeof env.payload !== 'string' || env.payload.length === 0) return false;
  const pb = Buffer.from(env.payload, 'base64');
  const ops = decodeLsResponse(pb);
  if (!ops) return false;
  for (const op of ops) {
    if (op.kind === 'subscribe') ev.subscribed = true;
    else if (op.kind === 'resnapshot' || op.kind === 'failure') ev.resnapshot = true;
    else if (op.kind === 'delta') {
      let wrappers: unknown;
      try {
        wrappers = parseJsonExact(op.delta);
      } catch {
        continue;
      }
      if (!Array.isArray(wrappers)) continue;
      for (const w of wrappers) {
        const list = (w as { data?: { slide_delta_processor?: unknown } })?.data?.slide_delta_processor;
        if (!Array.isArray(list)) continue;
        for (const d of list) if (d && typeof d === 'object') ev.deltas.push(d as RawDelta);
      }
    }
  }
  return true;
}

/** Decodes one binary WebSocket message of the lightspeed socket. */
export function decodeSocketMessage(buf: Buffer): StreamEvents {
  const ev: StreamEvents = { deltas: [], subscribed: false, resnapshot: false };
  for (const f of parseDataFrames(buf)) decodeDataPayload(f.payload, ev);
  return ev;
}

/* ------------------------------------------------------------ test helpers */

function varint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function pbBytes(no: number, value: Buffer): Buffer {
  return Buffer.concat([varint((no << 3) | 2), varint(value.length), value]);
}

function pbVarint(no: number, value: number): Buffer {
  return Buffer.concat([varint(no << 3), varint(value)]);
}

/**
 * Builds what Instagram's server sends for a list of deltas (used by tests and the fake Instagram). [deltas] may be
 * the delta list's JSON text (to send numbers JSON.stringify can't write exactly).
 */
export function encodeDeltaMessage(deltas: object[] | string, opts: { streamId?: number; subscribe?: { subscribed: number; latest: number } } = {}): Buffer {
  const ops: Buffer[] = [];
  if (opts.subscribe) {
    ops.push(pbBytes(2, pbBytes(1, Buffer.concat([pbVarint(1, 1), pbVarint(2, opts.subscribe.subscribed), pbVarint(3, opts.subscribe.latest)]))));
  }
  if (deltas.length) {
    const delta = typeof deltas === 'string' ? `[{"data":{"slide_delta_processor":${deltas}}}]` : JSON.stringify([{ data: { slide_delta_processor: deltas } }]);
    ops.push(pbBytes(2, pbBytes(3, Buffer.concat([pbVarint(1, 1), pbBytes(2, Buffer.from(delta, 'utf8'))]))));
  }
  const envelope = Buffer.from(JSON.stringify({ request_id: null, payload: Buffer.concat(ops).toString('base64') }), 'utf8');
  const header = Buffer.alloc(8);
  header[0] = FrameType.Data;
  header.writeUInt16LE(opts.streamId ?? 1, 1);
  const len = envelope.length + 2;
  header[3] = len & 0xff;
  header[4] = (len >> 8) & 0xff;
  header[5] = (len >> 16) & 0xff;
  header.writeUInt16LE(0, 6);
  return Buffer.concat([header, envelope]);
}
