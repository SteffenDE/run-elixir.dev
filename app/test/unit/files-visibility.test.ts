import { afterEach, expect, test, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: { load: vi.fn(), save: vi.fn() },
}));
vi.mock('../../src/runtime/overlay', () => ({ remote: () => store }));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('/shared is restored when permission changes while hiding waits for storage', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const post = vi.fn();
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => new Response(url.pathname.endsWith('manifest.json') ? '[]' : '')),
  );
  store.load.mockResolvedValue({ version: '', records: [] });
  let finishSaving!: () => void;
  let savingStarted!: () => void;
  const saving = new Promise<void>((resolve) => (savingStarted = resolve));
  store.save.mockImplementation(() => {
    savingStarted();
    return new Promise<void>((resolve) => (finishSaving = resolve));
  });
  await import('../../src/runtime/files');
  const send = globalThis.onmessage as unknown as (event: { data: object }) => Promise<void>;
  const dispatch = (data: object) => send({ data });
  await dispatch({
    kind: 'start',
    runtime: 'https://runtime.test/',
    boots: [],
    sharedPort: {},
    doorbell: new SharedArrayBuffer(4),
  });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }), []);
  await dispatch({
    kind: 'request',
    id: 1,
    op: 'write',
    path: '/shared/notes.txt',
    data: new TextEncoder().encode('before hiding'),
  });
  const hiding = dispatch({ kind: 'request', id: 2, op: 'hide-shared', hide: true });
  await saving;
  const restoring = dispatch({ kind: 'request', id: 3, op: 'hide-shared', hide: false });
  finishSaving();
  await Promise.all([hiding, restoring]);

  await dispatch({ kind: 'request', id: 4, op: 'read', path: '/shared/notes.txt' });
  const reply = post.mock.calls.find(([message]) => message.id === 4)?.[0];
  expect(reply.error).toBeUndefined();
  expect(new TextDecoder().decode(reply.data)).toBe('before hiding');
});
