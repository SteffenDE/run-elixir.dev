// Where things run (docs/frames.md). The apex (playground.json's `domain`,
// build.py's PLAYGROUND_DOMAIN, serve.py's --domain) is the one trusted
// origin: the projects' list, every project's page (/ID/), the stores. What
// a project's code makes the browser run is kept on another site, the
// usercontent domain (`usercontent`, PLAYGROUND_USERCONTENT,
// --usercontent): its preview has an origin per port of its app
// (v-ID-PORT.USERCONTENT), so the app's pages reach nothing of the apex's,
// nor of other projects', nor of its other ports' (as Livebook's notebook
// outputs, on its second port, are meant to be), and several ports show at
// once.
//
// Before, each project ran on an origin of its own under the apex
// (p-ID.DOMAIN, and a live session's guest on l-ID.DOMAIN): those
// addresses now go to the apex's.
import { bridgeKey, siteRoot } from './apexLink';
import { isId } from './ids';

// A domain's scheme (docs/frames.md, "Schemes"): the one a domain is
// written with (https://run-elixir-usercontent.org), else https, but http
// for a local one: localhost, *.localhost, or a host with a port
// (serve.py's and the Vite plugin's playground.localhost:8081). This
// page's own host keeps this page's scheme. Never the page's scheme for
// another domain: a page on http://localhost:9000 frames the shared
// domain's https origins (an http one answers with a redirect, which a
// cross-origin isolated page refuses to frame).
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
export function domainScheme(domain: string): 'http:' | 'https:' {
  const written = domain.match(SCHEME)?.[1].toLowerCase();
  if (written === 'http' || written === 'https') return `${written}:`;
  if (written) throw new Error(`${domain}: a domain is http or https`);
  const host = domain.replace(/\/+$/, '').toLowerCase();
  if (host === location.host.toLowerCase()) return location.protocol as 'http:' | 'https:';
  const name = host.replace(/:\d+$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name !== host ? 'http:' : 'https:';
}
// A domain without its scheme: a host, with a port if any.
export const domainHost = (domain: string) => domain.replace(SCHEME, '').replace(/\/+$/, '');
// The origin of the domain itself, or of `name` below it.
export const domainOrigin = (domain: string, name?: string) =>
  `${domainScheme(domain)}//${name ? `${name}.` : ''}${domainHost(domain)}`;

interface Site {
  // The apex (with a port, if any; with its scheme, if playground.json
  // names one), or null: this origin is the apex.
  domain: string | null;
  // The usercontent domain (with a port, if any; with its scheme, if
  // named), or null.
  usercontent: string | null;
  // Which project's preview, and of which port, this origin is
  // (v-ID-PORT.USERCONTENT).
  preview: { project: string; port: number } | null;
  // An address of the apex's former layout: where the apex has it now.
  moved: string | null;
  // A name under either domain that is no address (a reserved name, or a
  // mistyped one).
  stray: boolean;
}

let site: Site = {
  domain: null,
  usercontent: null,
  preview: null,
  moved: null,
  stray: false,
};

// A preview of one port of a project's app (or a temporary IEx's): v-, its
// id and the port.
const PREVIEW = /^v-([a-z0-9]{10})-(\d{1,5})$/;
function previewName(name: string): { project: string; port: number } | null {
  const match = name.match(PREVIEW);
  const port = match ? Number(match[2]) : 0;
  return match && isId(match[1]) && port > 0 && port < 65536 ? { project: match[1], port } : null;
}

// The former layout's addresses under the apex: a project's (p-ID, its
// page at /) and a live session's guest page (l-SESSION, /live/SESSION).
function movedFrom(name: string): string | null {
  const project = name.match(/^p-([a-z0-9]{10})$/)?.[1];
  if (project && isId(project)) return `/${project}/`;
  if (name.startsWith('l-') && location.pathname.startsWith('/live/')) return location.pathname;
  return null;
}

// Read the site's configuration, once, before anything asks. A bridged
// frame (bridge mode, docs/frames.md) asks its bridge: the apex's worker
// answers for the apex, which is its only parent.
export async function loadSite(): Promise<void> {
  const config: { domain?: unknown; usercontent?: unknown } = await fetch(
    bridgeKey() ? `${siteRoot()}playground.json` : '/playground.json',
    {
      cache: 'no-cache',
    },
  )
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  const domain = typeof config.domain === 'string' && config.domain ? config.domain : null;
  const usercontent =
    typeof config.usercontent === 'string' && config.usercontent ? config.usercontent : null;
  site = { domain, usercontent, preview: null, moved: null, stray: false };
  const host = location.host;
  const shared = usercontent && domainHost(usercontent);
  const apex = domain && domainHost(domain);
  if (shared && host.endsWith(`.${shared}`)) {
    site.preview = previewName(host.slice(0, -shared.length - 1));
    site.stray = !site.preview;
  } else if (apex && host.endsWith(`.${apex}`)) {
    site.moved = movedFrom(host.slice(0, -apex.length - 1));
    site.stray = !site.moved;
  }
}

// The page that may be a usercontent frame's parent: its apex, the page
// that bridged it (its playground.json comes from that page's worker). A
// frame says it loaded to any parent (nothing is in it) and takes calls
// from it alone.
export const parentOrigins = () => [apexOrigin()];

// The usercontent domain, if the site has one (with its scheme, if named).
export const usercontentDomain = () => site.usercontent;
// The apex's host the site names (with a port, if any), or null.
export const siteDomain = () => site.domain && domainHost(site.domain);
// This page is on a name that is no address.
export const strayOrigin = () => site.stray;
// This page is on a preview origin: which project and port.
export const previewSite = () => site.preview;
// This page is an address of the former layout: where it is now, on the
// apex.
export const movedTo = () => (site.moved ? apexUrl(site.moved) : null);
// This page is a project's former origin (p-ID.DOMAIN): its id.
export const formerProject = () => site.moved?.match(/^\/([a-z0-9]{10})\/$/)?.[1] ?? null;
// Where project `id`'s former origin keeps its stores' frame (storage.html):
// its stores move to the apex through it (migrate.ts).
export const formerStorage = (id: string) =>
  site.domain && isId(id) ? `${domainOrigin(site.domain, `p-${id}`)}/storage.html` : null;

// Where project `id`'s preview shows a port of its app, with {port} for
// it (v-ID-{port}.USERCONTENT); null without a usercontent domain.
// `usercontent`: a sandbox's own (the api's create()), not the page's.
export function previewOrigins(id: string, usercontent = site.usercontent): string | null {
  return usercontent && isId(id) ? domainOrigin(usercontent, `v-${id}-{port}`) : null;
}
export const previewOrigin = (id: string, port: number, usercontent = site.usercontent) =>
  previewOrigins(id, usercontent)?.replace('{port}', String(port)) ?? null;

// Where the worker that runs project `key` lives (e-KEY.USERCONTENT); null
// without a usercontent domain.
export const execOrigin = (key: string, usercontent = site.usercontent) =>
  usercontent && isId(key) ? domainOrigin(usercontent, `e-${key}`) : null;

export const projectUrl = (id: string) => apexUrl(`/${id}/`);

// A path on the apex, from anywhere.
export function apexUrl(path: string): string {
  return site.domain ? `${domainOrigin(site.domain)}${path}` : path;
}

export const apexOrigin = () => new URL(apexUrl('/'), location.href).origin;
