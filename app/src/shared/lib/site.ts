// Where projects live. Without a project domain, everything is one origin
// and a project is a path (/ID/). With one (playground.json's `domain`,
// build.py's PLAYGROUND_DOMAIN, serve.py's --domain), the apex (DOMAIN)
// has the projects' list, new ones and links, and each project runs on an
// origin of its own (p-ID.DOMAIN): its files, database, service worker,
// cookies and preview are its own, and the preview's requests can only
// be its. The two talk through hidden frames (frames.ts).
import { isId } from './projects';

interface Site {
  // The project domain (with a port, if any), or null.
  domain: string | null;
  // Which project this origin is (on a project domain), else null.
  project: string | null;
  // A subdomain that is no project's (a reserved name, or a mistyped one).
  stray: boolean;
  // Which live session this origin is a guest's page for (l-ID.DOMAIN).
  live: string | null;
}

let site: Site = { domain: null, project: null, stray: false, live: null };

// A project's subdomain: p- and its id (p- and a chosen name, later). Every
// other name under the domain is reserved (www, phoenix, ...).
const PREFIX = 'p-';
// A live session's guest page runs on an origin of its own, l- and the
// session's id (lowercase; ids are base64url), so the host's app in its
// preview reaches nothing else of the site (docs/collaboration.md).
const LIVE = 'l-';
const subdomain = (id: string) => `${PREFIX}${id}`;
function idOf(name: string): string | null {
  return name.startsWith(PREFIX) && isId(name.slice(PREFIX.length))
    ? name.slice(PREFIX.length)
    : null;
}

// Read the site's configuration, once, before anything asks.
export async function loadSite(): Promise<void> {
  const config: { domain?: unknown } = await fetch('/playground.json', { cache: 'no-cache' })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  const domain = typeof config.domain === 'string' && config.domain ? config.domain : null;
  if (!domain) return;
  const host = location.host;
  if (host === domain) {
    if (window.parent === window && apexOnOneOrigin()) return;
    site = { domain, project: null, stray: false, live: null };
  } else if (host.endsWith(`.${domain}`)) {
    const name = host.slice(0, -domain.length - 1);
    const live = name.startsWith(LIVE) ? name.slice(LIVE.length) : null;
    const id = live ? null : idOf(name);
    site = { domain, project: id, stray: id === null && !live, live };
  }
  // Another name for the site (an address): one origin, as without.
}

// Projects have origins of their own.
export const onDomain = () => site.domain !== null;
// This page is a project's own origin: its id.
export const projectOrigin = () => site.project;
// This page is on a subdomain that is no project's.
export const strayOrigin = () => site.stray;
// This page is a live session's guest origin (l-ID.DOMAIN).
export const liveOrigin = () => site.live !== null;

// Where a guest joins live session `session` (its link's fragment follows):
// an origin of its own on a project domain, else the site's /live/ID.
export function liveUrl(session: string): string {
  return site.domain
    ? `${location.protocol}//${LIVE}${session.toLowerCase()}.${site.domain}/live/${session}`
    : `/live/${session}`;
}

export function projectUrl(id: string): string {
  return site.domain ? `${location.protocol}//${subdomain(id)}.${site.domain}/` : `/${id}/`;
}

// A path on the apex (the projects' list, links), from anywhere.
export function apexUrl(path: string): string {
  return site.domain ? `${location.protocol}//${site.domain}${path}` : path;
}

export const apexOrigin = () => new URL(apexUrl('/'), location.href).origin;

// The project an origin is, on the project domain; null for any other.
export function projectOf(origin: string): string | null {
  if (!site.domain) return null;
  const { protocol, host } = new URL(origin);
  if (protocol !== location.protocol || !host.endsWith(`.${site.domain}`)) return null;
  return idOf(host.slice(0, -site.domain.length - 1));
}

// Safari (and every browser on iOS) keys a frame's storage by the page's
// origin, not its site, so the apex's frames on a project's origin and a
// project's on the apex see stores of their own, empty. There the apex
// runs its projects itself, as a site without a project domain does.
//
// It is found out, not guessed from the browser's name: the apex's own
// page keeps a key in its local storage and in a cookie, which a frame
// reads either way (the two origins are one site). A registry frame that
// sees the cookie but not the key in its storage is partitioned
// (apexPartitioned); the project's page then sends the browser to the
// apex's /ID/?one-origin, and the apex keeps running projects itself.
const KEY = 'playground-apex';
const ONE_ORIGIN = 'playground-one-origin';

function apexOnOneOrigin(): boolean {
  try {
    let key = localStorage.getItem(KEY);
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem(KEY, key);
    }
    document.cookie = `${KEY}=${key}; path=/; max-age=31536000; SameSite=Lax`;
    const url = new URL(location.href);
    if (url.searchParams.has('one-origin')) {
      localStorage.setItem(ONE_ORIGIN, '1');
      url.searchParams.delete('one-origin');
      history.replaceState(null, '', url);
    }
    return localStorage.getItem(ONE_ORIGIN) === '1';
  } catch {
    return false;
  }
}

// In the apex's registry frame: its storage is not the apex page's.
export function apexPartitioned(): boolean {
  const cookie = document.cookie
    .split('; ')
    .find((pair) => pair.startsWith(`${KEY}=`))
    ?.slice(KEY.length + 1);
  try {
    return !!cookie && localStorage.getItem(KEY) !== cookie;
  } catch {
    return !!cookie;
  }
}

// From a project's origin whose apex frame is partitioned: the project,
// on the apex.
export const oneOriginUrl = (id: string) => apexUrl(`/${id}/?one-origin`);
