import net from 'node:net';
import { vncAuthResponse } from '../vnc/des.js';

/** A tiny RFB 3.8 server with VNC auth that records the client's input messages. */
export function fakeVncServer(password: string, size = { w: 1280, h: 800 }) {
  const received: Buffer[] = [];
  let authOk: boolean | null = null;
  const server = net.createServer((sock) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    const challenge = Buffer.from('fedcba9876543210');
    sock.write('RFB 003.008\n');
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 2]));
          stage = 1;
        } else if (stage === 1 && buf.length >= 1) {
          buf = buf.subarray(1);
          sock.write(challenge);
          stage = 2;
        } else if (stage === 2 && buf.length >= 16) {
          authOk = buf.subarray(0, 16).equals(vncAuthResponse(password, challenge));
          buf = buf.subarray(16);
          const r = Buffer.alloc(4);
          r.writeUInt32BE(authOk ? 0 : 1);
          sock.write(r);
          if (!authOk) sock.end();
          stage = 3;
        } else if (stage === 3 && buf.length >= 1) {
          buf = buf.subarray(1);
          const init = Buffer.alloc(24 + 4);
          init.writeUInt16BE(size.w, 0);
          init.writeUInt16BE(size.h, 2);
          init.writeUInt32BE(4, 20);
          init.write('test', 24);
          sock.write(init);
          stage = 4;
        } else if (stage === 4 && buf.length > 0) {
          const n = buf[0] === 5 ? 6 : buf[0] === 4 ? 8 : buf.length;
          if (buf.length < n) break;
          received.push(Buffer.from(buf.subarray(0, n)));
          buf = buf.subarray(n);
        } else break;
      }
    });
    sock.on('error', () => undefined);
  });
  return {
    server,
    received,
    authOk: () => authOk,
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    connect: (port: number) => new Promise<net.Socket>((r) => {
      const s = net.connect(port, '127.0.0.1', () => r(s));
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
