// Whether a bridged worker's requests still reach a service worker (bridge
// mode, docs/frames.md, "When a frame loses its service worker"). They
// stop when Safari deletes the shared domain's registration (Intelligent
// Tracking Prevention), or when a newer worker took over and Safari kept
// the frame's dedicated workers with the old, now redundant one. Their
// loads below /_bridge/KEY/ then reach the shared domain's server, which
// has none of them (404).

// What the exec frame's host worker warns when they do not.
export const DETACHED =
  'This page lost the playground’s service worker, and new processes cannot start. Reload the page.';

// Why the host worker checked: the frame's controller changed, a worker
// did not load, or the page became visible again.
export type DetachedReason = 'controllerchange' | 'load' | 'visible';

// `url`: a file below the bridge that exists, such as the worker's own
// script, which only a service worker answers.
export async function reachesServiceWorker(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(url, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  // A failed request says nothing either way.
  return response?.status !== 404;
}
