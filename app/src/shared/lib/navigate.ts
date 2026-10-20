// Going from one of the apex's pages to another without loading the page
// (main.tsx renders the next in place): what lives as long as the tab does
// stays, the Tailscale node's connection above all (docs/tailscale.md). A
// link to one of the app's routes is followed so; any other (a new tab, a
// file, another origin) as the browser would.
type Show = (url: URL) => void;

let show: Show | null = null;

// Go to `to` (a path or URL): in place when it is one of the app's routes
// on this origin, else by loading it.
export function navigate(to: string, { replace = false } = {}): void {
  const url = new URL(to, location.href);
  if (!show || !routes?.(url)) {
    if (replace) location.replace(url);
    else location.assign(url);
    return;
  }
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  show(url);
}

let routes: ((url: URL) => boolean) | null = null;

// Render the page for each URL the tab goes to: links to `isRoute` URLs,
// navigate(), back and forward.
export function routeWith(isRoute: (url: URL) => boolean, render: Show): void {
  routes = (url) => url.origin === location.origin && isRoute(url);
  show = render;
  addEventListener('popstate', () => render(new URL(location.href)));
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (!routes!(url)) return;
    // A link to this page's own part (#…) is the browser's.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    navigate(url.href);
  });
}
