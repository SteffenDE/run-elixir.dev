import { afterEach, expect, test, vi } from 'vitest';
import { Rpc } from '../../../src/lib/rpc';
import { claudeProgram } from '../../../src/programs/claude/claude';
import type { Context, Process } from '../../../src/programs/tailwind';

vi.mock('../../../src/programs/claude/build', () => ({ DIR: '/opt/claude-code' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function prepare() {
  const channel = new MessageChannel();
  const requested = deferred<void>();
  const files = deferred<{ version: string; files: [] }>();
  const server = new Rpc(channel.port2).handle({
    files: () => {
      requested.resolve();
      return files.promise;
    },
  });
  cleanup.push(() => {
    channel.port1.close();
    server.close();
  });
  const process: Process = { write: vi.fn(), exit: vi.fn(), onkill: null, onowner: null };
  const fs = { stat: vi.fn(async () => 'file'), mkdir: vi.fn(), write: vi.fn() };
  const context = { args: ['-p'], cwd: '/work', env: {}, fs } as unknown as Context;
  return { channel, requested, files, process, context, fs };
}

test('keeps piped input and EOF until the Node runtime installs its input handler', async () => {
  const prepared = prepare();
  const received: (Uint8Array | null)[] = [];
  const node = vi.fn((process: Process) => {
    process.oninput = (bytes) => {
      received.push(bytes);
    };
  });
  const starting = claudeProgram(
    () => ({ node }),
    async () => prepared.channel.port1,
  )(prepared.process, prepared.context);
  await prepared.requested.promise;
  prepared.process.oninput!(new TextEncoder().encode('prompt'));
  prepared.process.oninput!(null);
  prepared.files.resolve({ version: 'test', files: [] });
  await starting;
  expect(node).toHaveBeenCalledOnce();
  expect(new TextDecoder().decode(received[0]!)).toBe('prompt');
  expect(received[1]).toBeNull();
});

test.each(['onkill', 'onowner'] as const)(
  '%s during preparation never starts Node',
  async (event) => {
    const prepared = prepare();
    const node = vi.fn();
    const starting = claudeProgram(
      () => ({ node }),
      async () => prepared.channel.port1,
    )(prepared.process, prepared.context);
    await prepared.requested.promise;
    prepared.process[event]!();
    await starting;
    prepared.files.resolve({ version: 'test', files: [] });
    expect(prepared.process.exit).toHaveBeenCalledWith(130);
    expect(node).not.toHaveBeenCalled();
    expect(prepared.fs.stat).not.toHaveBeenCalled();
  },
);

test('cancellation while connecting closes the eventual port without installing files', async () => {
  const prepared = prepare();
  const connection = deferred<MessagePort>();
  const node = vi.fn();
  const starting = claudeProgram(
    () => ({ node }),
    () => connection.promise,
  )(prepared.process, prepared.context);
  prepared.process.onkill!();
  connection.resolve(prepared.channel.port1);
  await starting;
  expect(node).not.toHaveBeenCalled();
  expect(prepared.fs.stat).not.toHaveBeenCalled();
});

test('cancellation during installation stops before creating or writing files', async () => {
  const prepared = prepare();
  const inspecting = deferred<void>();
  const inspected = deferred<string>();
  prepared.fs.stat.mockImplementation(() => {
    inspecting.resolve();
    return inspected.promise;
  });
  const node = vi.fn();
  const starting = claudeProgram(
    () => ({ node }),
    async () => prepared.channel.port1,
  )(prepared.process, prepared.context);
  prepared.files.resolve({ version: 'test', files: [] });
  await inspecting.promise;
  prepared.process.onowner!();
  inspected.resolve('');
  await starting;
  expect(node).not.toHaveBeenCalled();
  expect(prepared.fs.mkdir).not.toHaveBeenCalled();
  expect(prepared.fs.write).not.toHaveBeenCalled();
});
