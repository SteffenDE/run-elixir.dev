// After a newer service worker took over a bridged frame (bridge mode,
// docs/frames.md, "Service worker updates"): whether a worker's requests
// still reach a service worker. A frame's dedicated workers should follow
// the new worker, but Safari kept them with the old one, now redundant:
// their loads below /_bridge/KEY/ went to the shared domain's server,
// which has none of them (404).

// What the exec frame's host worker warns when they do not.
export const UPDATED =
  'The playground was updated while this page was open, and new processes cannot start. Reload the page.';

// `url`: a file below the bridge, such as the worker's own script, which
// only a service worker answers.
export async function reachesServiceWorker(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(url, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  // A failed request says nothing either way.
  return response?.status !== 404;
}
