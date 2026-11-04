// lib/controller.ts: whether a bridged worker's requests still reach a
// service worker.
import { expect, it, vi } from 'vitest';
import { reachesServiceWorker } from '../../src/lib/controller';

const URL =
  'https://e-abcdefghij.bridge.test/_bridge/KEY/npm/@elixir-playground/runtime@2.1.0/chunks/host.js';

it('asks for the file below the bridge without the cache', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
  expect(await reachesServiceWorker(URL, fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledWith(URL, { method: 'HEAD', cache: 'no-store' });
});

it('does not when the shared domain’s server answers 404', async () => {
  expect(await reachesServiceWorker(URL, async () => new Response(null, { status: 404 }))).toBe(
    false,
  );
});

it('says nothing of a service worker’s own failures or a failed request', async () => {
  for (const status of [503, 504, 405])
    expect(await reachesServiceWorker(URL, async () => new Response(null, { status }))).toBe(true);
  expect(
    await reachesServiceWorker(URL, async () => {
      throw new TypeError('offline');
    }),
  ).toBe(true);
});
