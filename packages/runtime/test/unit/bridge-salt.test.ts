// Bridge mode's salt (packages/api/src/usercontent.ts): one per page load,
// kept in local storage. It names a project's origins, never its stores,
// which stay where they are without it (docs/api.md).
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

// Local storage as the page has it: working, or refusing.
let storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
const working = () => {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
};
const refusing = () => ({
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
});

let api: typeof import('../../../api/src/usercontent');
let sandbox: typeof import('../../../api/src/sandbox');
beforeAll(async () => {
  vi.stubGlobal('location', new URL('https://apex.test/'));
  vi.stubGlobal('document', { querySelector: () => null, readyState: 'complete' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  });
  api = await import('../../../api/src/usercontent');
  sandbox = await import('../../../api/src/sandbox');
});
afterEach(() => {
  api.forgetBridgeSalt();
  vi.unstubAllGlobals();
  vi.stubGlobal('location', new URL('https://apex.test/'));
  vi.stubGlobal('document', { querySelector: () => null, readyState: 'complete' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  });
});

it('keeps one salt for the page when local storage refuses it', () => {
  storage = refusing();
  const salt = api.bridgeSalt();
  expect(salt).toMatch(/^[0-9a-f]{32}$/);
  expect(api.bridgeSalt()).toBe(salt);
});

it('keeps the salt in local storage, for the next load too', () => {
  storage = working();
  const salt = api.bridgeSalt();
  expect(storage.getItem('playground-bridge-salt')).toBe(salt);
  api.forgetBridgeSalt();
  expect(api.bridgeSalt()).toBe(salt);
});

it('names a project’s stores without the salt, and its origins with it', async () => {
  storage = working();
  const keys = await sandbox.projectKeys('my-project');
  // The stores: as before bridge mode, so a kept project moves along.
  expect(keys.store).toMatch(/^[a-z0-9]{10}$/);
  expect(keys.origin).toMatch(/^[a-z0-9]{10}$/);
  expect(keys.origin).not.toBe(keys.store);
  // An id that already is a key: its stores keep it; its origins do not.
  const id = 'abcdefghij';
  const given = await sandbox.projectKeys(id);
  expect(given.store).toBe(id);
  expect(given.origin).not.toBe(id);
});

it('keeps a project’s stores when the salt is lost, and only its origins change', async () => {
  storage = refusing();
  const first = await sandbox.projectKeys('my-project');
  api.forgetBridgeSalt();
  const next = await sandbox.projectKeys('my-project');
  expect(next.store).toBe(first.store);
  expect(next.origin).not.toBe(first.origin);
});

it('keeps a project without local storage', async () => {
  storage = refusing();
  vi.stubGlobal('crossOriginIsolated', true);
  // Past every check of its own: on to the packages (none here).
  await expect(
    sandbox.create({
      plugins: [],
      project: { id: 'my-project', template: 'empty', persist: true },
      usercontent: 'bridge.test',
      services: { relay: null, nif: null, git: null },
    }),
  ).rejects.toMatchObject({ code: 'ERUNTIME' });
});
