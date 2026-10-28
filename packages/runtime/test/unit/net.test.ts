import { describe, expect, test } from 'vitest';
import { createNet } from '../../src/nodejs/net';

describe('net', () => {
  test('a connection reset on the way is an ECONNRESET, not an end', async () => {
    const posted: { op: string; id?: number }[] = [];
    const { module, receive } = createNet(
      (message) => posted.push(message as { op: string }),
      () => () => {},
    );
    const socket = module.connect(80, '100.64.0.2');
    const events: string[] = [];
    socket.on('end', () => events.push('end'));
    const failed = new Promise<Error & { code?: string }>((resolve) => socket.on('error', resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { id } = posted.find(({ op }) => op === 'connect')!;
    receive({ kind: 'net', op: 'connected', id: id! });
    receive({ kind: 'net', op: 'reset', id: id! });
    const error = await failed;
    expect(error.code).toBe('ECONNRESET');
    expect(events).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });
});
