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
import { isId } from './ids';

interface Site {
  // The apex (with a port, if any), or null: this origin is the apex.
  domain: string | null;
  // The usercontent domain (with a port, if any), or null.
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

let site: Site = { domain: null, usercontent: null, preview: null, moved: null, stray: false };

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

// Read the site's configuration, once, before anything asks.
export async function loadSite(): Promise<void> {
  const config: { domain?: unknown; usercontent?: unknown } = await fetch('/playground.json', {
    cache: 'no-cache',
  })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  const domain = typeof config.domain === 'string' && config.domain ? config.domain : null;
  const usercontent =
    typeof config.usercontent === 'string' && config.usercontent ? config.usercontent : null;
  site = { domain, usercontent, preview: null, moved: null, stray: false };
  const host = location.host;
  if (usercontent && host.endsWith(`.${usercontent}`)) {
    site.preview = previewName(host.slice(0, -usercontent.length - 1));
    site.stray = !site.preview;
  } else if (domain && host.endsWith(`.${domain}`)) {
    site.moved = movedFrom(host.slice(0, -domain.length - 1));
    site.stray = !site.moved;
  }
}

// The usercontent domain, if the site has one.
export const usercontentDomain = () => site.usercontent;
// This page is on a name that is no address.
export const strayOrigin = () => site.stray;
// This page is on a preview origin: which project and port.
export const previewSite = () => site.preview;
// This page is an address of the former layout: where it is now, on the
// apex.
export const movedTo = () => (site.moved ? apexUrl(site.moved) : null);

// Where project `id`'s preview shows a port of its app, with {port} for
// it (v-ID-{port}.USERCONTENT); null without a usercontent domain.
export function previewOrigins(id: string): string | null {
  return site.usercontent && isId(id)
    ? `${location.protocol}//v-${id}-{port}.${site.usercontent}`
    : null;
}
export const previewOrigin = (id: string, port: number) =>
  previewOrigins(id)?.replace('{port}', String(port)) ?? null;

// Where the worker that runs project `key` lives (e-KEY.USERCONTENT); null
// without a usercontent domain.
export const execOrigin = (key: string) =>
  site.usercontent && isId(key) ? `${location.protocol}//e-${key}.${site.usercontent}` : null;

export const projectUrl = (id: string) => apexUrl(`/${id}/`);

// A path on the apex, from anywhere.
export function apexUrl(path: string): string {
  return site.domain ? `${location.protocol}//${site.domain}${path}` : path;
}

export const apexOrigin = () => new URL(apexUrl('/'), location.href).origin;
