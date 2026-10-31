import { afterEach, describe, expect, it } from 'vitest';
import { desEncryptBlock, vncAuthResponse } from './des.js';
import { isInputMessage } from './bridge.js';
import { RfbInput } from './rfb.js';
import { fakeVncServer } from '../testutil/fakevnc.js';

describe('DES / VNC auth', () => {
  it('matches the classic DES test vector', () => {
    expect(desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex')).toBe('85e813540f0ab405');
  });

  it('answers a VNC challenge like OpenSSL with bit-reversed key bytes', () => {
    // openssl enc -des-ecb -nopad -provider legacy -K <"secret12" bit-reversed> <<< "0123456789abcdef"
    expect(vncAuthResponse('secret12', Buffer.from('0123456789abcdef')).toString('hex')).toBe('5f15f4f0e1684cdc260ea962ab82fa3b');
    // Only the first 8 password bytes count (VNC's limit).
    expect(vncAuthResponse('secret12-and-more', Buffer.from('0123456789abcdef')).toString('hex')).toBe('5f15f4f0e1684cdc260ea962ab82fa3b');
  });
});

describe('isInputMessage', () => {
  it('recognises noVNC pointer and key events only', () => {
    expect(isInputMessage(Buffer.from([5, 0, 0, 10, 0, 20]))).toBe(true);
    expect(isInputMessage(Buffer.from([5, 0, 0, 10, 0, 20, 5, 1, 0, 11, 0, 21]))).toBe(true);
    expect(isInputMessage(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]))).toBe(true);
    expect(isInputMessage(Buffer.from([3, 1, 0, 0, 0, 0, 4, 0, 3, 0]))).toBe(false); // update request
    expect(isInputMessage(Buffer.from('RFB 003.008\n'))).toBe(false);
    expect(isInputMessage(Buffer.from([4, 1, 7, 7, 0, 0, 0, 0x61]))).toBe(false);
    expect(isInputMessage(Buffer.from([2]))).toBe(false);
  });
});

describe('RfbInput', () => {
  let fake: ReturnType<typeof fakeVncServer> | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it('authenticates and sends pointer and key events', async () => {
    fake = fakeVncServer('pw123456');
    const port = await fake.listen();
    const rfb = await RfbInput.connect(await fake.connect(port), 'pw123456');
    expect(fake.authOk()).toBe(true);
    expect([rfb.width, rfb.height]).toEqual([1280, 800]);
    rfb.move(100, 200);
    rfb.button(100, 200, true);
    rfb.button(100, 200, false);
    rfb.key(0x61, true);
    rfb.key(0x61, false);
    rfb.move(5000, -3); // clamped to the screen
    await new Promise((r) => setTimeout(r, 50));
    rfb.close();
    expect(fake.received.map((b) => b.toString('hex'))).toEqual([
      '050000640' + '0c8',
      '050100640' + '0c8',
      '050000640' + '0c8',
      '0401000000000061',
      '0400000000000061',
      '050004ff0000',
    ]);
  });

  it('rejects a wrong password', async () => {
    fake = fakeVncServer('right-pw');
    const port = await fake.listen();
    await expect(RfbInput.connect(await fake.connect(port), 'wrong-pw')).rejects.toThrow(/authentication failed/);
  });
});
