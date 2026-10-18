import { describe, expect, it } from 'vitest';
import { decodeLsResponse, decodeSocketMessage, encodeDeltaMessage, parseDataFrames, parseJsonExact, pbFields } from './dgw.js';

const newMessage = { __typename: 'SlideUQPPNewMessage', uq_seq_id: '42', thread_fbid: '340282366841710300001', message: { message_id: 'mid.$x', timestamp_ms: '1760000000000' } };

describe('DGW stream decoding', () => {
  it('decodes deltas from a data frame (frame → JSON envelope → protobuf → delta JSON)', () => {
    const ev = decodeSocketMessage(encodeDeltaMessage([newMessage, { __typename: 'SlideUQPPDeleteMessage', thread_fbid: '1', message_id: 'mid.$y' }]));
    expect(ev.deltas).toHaveLength(2);
    expect(ev.deltas[0]).toMatchObject({ __typename: 'SlideUQPPNewMessage', thread_fbid: '340282366841710300001' });
    expect(ev.deltas[1]!.message_id).toBe('mid.$y');
    expect(ev.subscribed).toBe(false);
  });

  it('handles several frames in one WebSocket message, with pings and acks between them', () => {
    const ping = Buffer.from([9]);
    const ack = Buffer.from([12, 1, 0, 2, 0, 0, 5, 0]);
    const msg = Buffer.concat([ping, encodeDeltaMessage([newMessage], { streamId: 3 }), ack, encodeDeltaMessage([{ ...newMessage, uq_seq_id: '43' }])]);
    const frames = parseDataFrames(msg);
    expect(frames.map((f) => f.streamId)).toEqual([3, 1]);
    expect(decodeSocketMessage(msg).deltas.map((d) => d.uq_seq_id)).toEqual(['42', '43']);
  });

  it('reports subscribe operations', () => {
    const ev = decodeSocketMessage(encodeDeltaMessage([], { subscribe: { subscribed: 10, latest: 12 } }));
    expect(ev.subscribed).toBe(true);
    expect(ev.deltas).toEqual([]);
  });

  it('decodes the extended data frame variant (content-type byte)', () => {
    const normal = encodeDeltaMessage([newMessage]);
    const payload = normal.subarray(8);
    const len = payload.length + 3;
    const ext = Buffer.concat([Buffer.from([17, 1, 0, len & 255, (len >> 8) & 255, len >> 16, 0, 0, 1]), payload]);
    expect(decodeSocketMessage(ext).deltas).toHaveLength(1);
  });

  it('ignores garbage, truncated frames and non-stream payloads without throwing', () => {
    const good = encodeDeltaMessage([newMessage]);
    for (const bad of [
      Buffer.alloc(0),
      Buffer.from('hello'),
      good.subarray(0, good.length - 5),
      Buffer.from([13, 1, 0, 255, 255, 255, 0, 0]),
      Buffer.from([200, 1, 2, 3]),
      Buffer.concat([Buffer.from([13, 1, 0, 6, 0, 0, 0, 0]), Buffer.from('{"x":1}')]),
    ]) {
      expect(decodeSocketMessage(bad).deltas).toEqual([]);
    }
    const env = (payload: string) => Buffer.concat([Buffer.from([13, 1, 0, payload.length + 2, 0, 0, 0, 0]), Buffer.from(payload)]);
    expect(decodeSocketMessage(env('{"payload":"!!!notbase64"}')).deltas).toEqual([]);
    expect(decodeSocketMessage(env('{"payload":"CgM="}')).deltas).toEqual([]);
  });

  it('keeps ids above 2^53 exact', () => {
    const v = parseJsonExact('{"a":340282366841710300949128,"b":12,"c":1.5,"d":"x"}') as Record<string, unknown>;
    expect(v).toEqual({ a: '340282366841710300949128', b: 12, c: 1.5, d: 'x' });
    // A delta whose ids are bare JSON numbers.
    const ev = decodeSocketMessage(encodeDeltaMessage('[{"__typename":"SlideUQPPDeleteMessage","thread_fbid":340282366841710300949128,"message_id":"m"}]'));
    expect(ev.deltas[0]!.thread_fbid).toBe('340282366841710300949128');
  });

  it('reads protobuf varints, bytes and nested messages', () => {
    expect(pbFields(Buffer.from([0x08, 0x96, 0x01]))).toEqual([{ no: 1, wire: 0, value: 150n }]);
    expect(pbFields(Buffer.from([0x08, 0x96]))).toBeNull();
    expect(pbFields(Buffer.from([0x0b]))).toBeNull(); // group wire type
    expect(decodeLsResponse(Buffer.from([0x12, 0x02, 0x22, 0x00]))).toEqual([{ kind: 'noop' }]);
    expect(decodeLsResponse(Buffer.from([0x12, 0x05, 0x12, 0x03, 0x12, 0x01, 0x78]))).toEqual([{ kind: 'resnapshot', error: 'x' }]);
  });
});
