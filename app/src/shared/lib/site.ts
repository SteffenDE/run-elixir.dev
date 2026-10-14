// Where projects live. Without a project domain, everything is one origin
// and a project is a path (/ID/). With one (playground.json's `domain`,
// build.py's PLAYGROUND_DOMAIN, serve.py's --domain), the apex (DOMAIN)
// has the projects' list, new ones and links, and each project runs on an
// origin of its own (ID.DOMAIN): its files, database, service worker,
// cookies and preview are its own, and the preview's requests can only
// be its. The two talk through hidden frames (frames.ts).
import { isId } from './projects';

interface Site {
  // The project domain (with a port, if any), or null.
  domain: string | null;
  // Which project this origin is (on a project domain), else null.
  project: string | null;
}

let site: Site = { domain: null, project: null };

// Read the site's configuration, once, before anything asks.
export async function loadSite(): Promise<void> {
  const config: { domain?: unknown } = await fetch('/playground.json', { cache: 'no-cache' })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  const domain = typeof config.domain === 'string' && config.domain ? config.domain : null;
  if (!domain) return;
  const host = location.host;
  if (host === domain) site = { domain, project: null };
  else if (host.endsWith(`.${domain}`) && isId(host.slice(0, -domain.length - 1)))
    site = { domain, project: host.slice(0, -domain.length - 1) };
  // Another name for the site (an address): one origin, as without.
}

// Projects have origins of their own.
export const onDomain = () => site.domain !== null;
// This page is a project's own origin: its id.
export const projectOrigin = () => site.project;

export function projectUrl(id: string): string {
  return site.domain ? `${location.protocol}//${id}.${site.domain}/` : `/${id}/`;
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
  const id = host.slice(0, -site.domain.length - 1);
  return isId(id) ? id : null;
}
