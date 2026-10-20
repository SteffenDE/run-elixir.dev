import { describe, expect, test } from 'vitest';
import { createDgram } from '../../src/runtime/nodejs/dgram';

// dgram whose host binds every port asked for, and what it was sent.
function dgram() {
  const sent: { address: string; port: number; bytes: Uint8Array }[] = [];
  const dns = { promises: { lookup: async () => ({ address: '10.0.0.1' }) } };
  const { module, receive } = createDgram(
    (message) => {
      const m = message as { op: string; ref: number; port: number };
      if (m.op === 'udp-bind')
        queueMicrotask(() =>
          receive({ kind: 'net', op: 'udp-bound', ref: m.ref, port: m.port || 5000 }),
        );
      else if (m.op === 'udp-send') sent.push(message as never);
    },
    () => () => {},
    dns as never,
  );
  return { module, sent };
}

describe('a send', () => {
  test("without a port, not connected, is Node's ERR_SOCKET_BAD_PORT", () => {
    const { module } = dgram();
    const socket = module.createSocket('udp4');
    expect(() => socket.send('hi')).toThrow(
      expect.objectContaining({
        code: 'ERR_SOCKET_BAD_PORT',
        message: 'Port should be > 0 and < 65536. Received undefined.',
      }),
    );
    expect(() => socket.send('hi', 0, 'localhost')).toThrow(
      expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }),
    );
  });

  test('before connect is done is not connected', async () => {
    const { module, sent } = dgram();
    const socket = module.createSocket('udp4');
    socket.connect(53, 'example.com');
    expect(() => socket.send('hi')).toThrow(
      expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }),
    );
    await new Promise((resolve) => socket.once('connect', resolve));
    await new Promise((resolve) => socket.send('hi', resolve));
    expect(sent.map(({ address, port }) => `${address}:${port}`)).toEqual(['10.0.0.1:53']);
  });
});

test('a DataView is sent as it was when sent', async () => {
  const { module, sent } = dgram();
  const socket = module.createSocket('udp4');
  const view = new DataView(new Uint8Array([1, 2, 3]).buffer);
  const done = new Promise((resolve) => socket.send(view, 53, 'example.com', resolve));
  view.setUint8(0, 9);
  await done;
  expect([...sent[0].bytes]).toEqual([1, 2, 3]);
});
