import { afterEach, expect, test, vi } from 'vitest';
import type { KeptRecord } from '@/runtime/overlay';

const { store } = vi.hoisted(() => ({ store: { load: vi.fn(), save: vi.fn() } }));
vi.mock('@/runtime/overlay', async (original) => ({
  ...(await original<typeof import('@/runtime/overlay')>()),
  remote: () => store,
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function filesWorker(records: KeptRecord[] = []) {
  vi.resetModules();
  vi.useFakeTimers();
  const post = vi.fn();
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => new Response(url.pathname.endsWith('manifest.json') ? '[]' : '')),
  );
  store.load.mockResolvedValue({ version: '', records });
  store.save.mockResolvedValue(undefined);
  await import('@/runtime/files');
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
  let id = 0;
  const request = async (op: string, fields: object) => {
    const key = ++id;
    await dispatch({ kind: 'request', id: key, op, ...fields });
    return post.mock.calls.find(([message]) => message.id === key)?.[0];
  };
  return { dispatch, request };
}

test('/shared is restored when permission changes while hiding waits for storage', async () => {
  const { request } = await filesWorker();
  let finishSaving!: () => void;
  let savingStarted!: () => void;
  const saving = new Promise<void>((resolve) => (savingStarted = resolve));
  store.save.mockImplementation(() => {
    savingStarted();
    return new Promise<void>((resolve) => (finishSaving = resolve));
  });
  await request('write', {
    path: '/shared/notes.txt',
    data: new TextEncoder().encode('before hiding'),
  });
  const hiding = request('hide-shared', { hide: true });
  await saving;
  const restoring = request('hide-shared', { hide: false });
  finishSaving();
  await Promise.all([hiding, restoring]);
  const reply = await request('read', { path: '/shared/notes.txt' });
  expect(reply.error).toBeUndefined();
  expect(new TextDecoder().decode(reply.data)).toBe('before hiding');
});

const file = (path: string): KeptRecord => ({
  path,
  kind: 'file',
  data: new TextEncoder().encode('from peer'),
  mtime: '0',
});
const link: KeptRecord = { path: '/shared/shortcut', kind: 'link', target: '/work', mtime: '0' };

test('shared records never write outside /shared, including through symbolic links on load', async () => {
  const { request } = await filesWorker([
    link,
    file('/shared/shortcut/foreign.txt'),
    file('/work/foreign.txt'),
  ]);
  expect((await request('stat', { path: '/work/foreign.txt' })).type).toBeNull();
});

test('peer updates reject foreign paths and never follow a local symlink', async () => {
  const { dispatch, request } = await filesWorker([link]);
  await dispatch({ kind: 'apply', records: [file('/work/foreign.txt')] });
  await dispatch({ kind: 'apply', records: [file('/shared/shortcut/foreign.txt')] });
  expect((await request('stat', { path: '/work/foreign.txt' })).type).toBeNull();
  await dispatch({ kind: 'apply', records: [file('/shared/config/token')] });
  const reply = await request('read', { path: '/shared/config/token' });
  expect(new TextDecoder().decode(reply.data)).toBe('from peer');
});
