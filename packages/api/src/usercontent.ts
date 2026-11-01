// Where a page's projects run (docs/api.md, docs/frames.md): a shared
// usercontent domain that serves no packages (create({ usercontent }), the
// site's playground.json, or run-elixir.dev's), whose frames get every
// file from this page's worker (bridge mode). And where the backend's
// services are, which this page's worker reaches.
import { HOST, type Host } from '@elixir-playground/runtime/packages/check';
import type { Boot } from '@elixir-playground/runtime/packages/types';
import {
  domainHost,
  domainName,
  domainOrigin,
  domainScheme,
  loadSite,
  siteDomain,
  usercontentDomain,
} from '@elixir-playground/runtime/lib/site';
import type { BridgeTable } from './apexWorker';
import { contentPath, usercontentMeta } from './runtimePath';
import type { PackageDescriptor, ServicesOption, UsercontentOptions } from './types';

// The backend run-elixir.dev runs (docs/backend.md): its services answer
// the origins on its allowlist.
export const DEFAULT_SERVICES = 'https://run-elixir.dev';
// The shared usercontent domain run-elixir.dev runs (docs/deploy.md).
export const DEFAULT_USERCONTENT = 'run-elixir-usercontent.org';

// create()'s `usercontent`: the domain, and where this page serves the
// packages. By default the domain this page names
// (<meta name="playground-usercontent">), or its site
// (/playground.json), else run-elixir.dev's. Its domain with the scheme
// its origins have (site.ts domainScheme), so the frames, on another
// scheme than this page's perhaps, name the same origins.
export async function usercontentOf(
  option: string | UsercontentOptions | undefined,
): Promise<UsercontentOptions> {
  const given: UsercontentOptions = await (async () => {
    if (typeof option === 'string') return { domain: option };
    if (option) return option;
    const named = usercontentMeta();
    if (named) return { domain: named };
    await loadSite();
    return { domain: usercontentDomain() ?? DEFAULT_USERCONTENT };
  })();
  const { scheme, ...rest } = given;
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https')
    throw new Error(`usercontent.scheme: ${String(scheme)} is not http or https`);
  const domain = scheme ? `${scheme}://${domainHost(given.domain)}` : given.domain;
  return { ...rest, domain: domainOrigin(domain) };
}

export interface Bridge {
  // The shared usercontent domain, with its scheme.
  domain: string;
  // The directory the packages' bases resolve below: on the page's
  // origin, or a CDN's.
  content: string;
  // The bridge's paths, and where each comes from.
  table: BridgeTable;
  // The runtime's path below the bridge, and each package's.
  runtime: string;
  // Where this page serves the runtime package (its package.json there),
  // and what that package.json says.
  runtimeUrl: string;
  host: Host;
  packages: Map<string, string>;
}

// The services' URLs: a backend's origin (all three below it), or each
// its own. By default this site's own backend when the page is its apex
// (playground.json names it), else run-elixir.dev's.
export function servicesOf(option: ServicesOption | undefined): BridgeTable['services'] {
  const own = siteDomain() === location.host ? location.origin : null;
  const given = option ?? own ?? DEFAULT_SERVICES;
  const of = (origin: string) => {
    const base = new URL(origin, location.href);
    return {
      relay: `${base.origin.replace(/^http/, 'ws')}/relay`,
      nif: `${base.origin}/api/v1/nif/`,
      git: `${base.origin}/git/`,
    };
  };
  if (typeof given === 'string') return of(given);
  const fallback = of(own ?? DEFAULT_SERVICES);
  const url = (value: string | null | undefined, otherwise: string) =>
    value === null ? null : value === undefined ? otherwise : new URL(value, location.href).href;
  return {
    relay: url(given.relay, fallback.relay),
    nif: url(given.nif, fallback.nif),
    git: url(given.git, fallback.git),
  };
}

// Bridge mode's origin names (docs/frames.md, "What relies on storage
// partitioning"): any page of the apex's top-level site may run code on
// the shared domain's origins, and pages of one top-level site share their
// storage. So the names this page's frames use are not guessable from the
// caller's ids: they are salted with a secret of this page's origin, kept
// in its local storage (another site's frames cannot read it). One per
// page load, whatever the storage does. A salt that could not be kept
// lasts as long as the page: the next load's origins have other names,
// and what was kept on the old ones (a preview's cookies, the claude
// frame's cache) is made again. A kept project's files and database are
// on this page's origin, named without the salt (sandbox.ts projectKeys).
const SALT = 'playground-bridge-salt';
let pageSalt: string | null = null;
function salt(): string {
  if (pageSalt) return pageSalt;
  try {
    pageSalt = localStorage.getItem(SALT);
  } catch {}
  if (pageSalt) return pageSalt;
  pageSalt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  try {
    localStorage.setItem(SALT, pageSalt);
  } catch {}
  return pageSalt;
}
// Ten letters and digits of a digest (an origin's name, as ids.ts's).
export async function nameOf(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(digest.subarray(0, 10), (byte) => alphabet[byte % 36]).join('');
}
// In bridge mode: what a caller's name is salted with.
export const bridgeSalt = () => salt();
/** @internal For tests: forget the page's salt. */
export function forgetBridgeSalt(): void {
  pageSalt = null;
}

// A package's path below the bridge.
const below = (name: string, version: string) => `npm/${name}@${version}/`;

// The directory `content` names (a page-relative URL, or one of another
// origin), with a trailing slash; and a path below it: a leading slash
// does not leave it, so `/npm/…` below https://example.com/web/ is
// https://example.com/web/npm/…. A URL of its own stays as it is.
export function contentDirectory(content: string): string {
  const url = new URL(content, location.href);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = url.hash = '';
  return url.href;
}
export const belowContent = (content: string, path: string): URL =>
  new URL(path.replace(/^\/+/, ''), content);

// A package's directory below `content`: its descriptor's base, or where
// usercontent.packagePath says ('{name}@{version}/' for unpkg's layout).
// A base that is a URL of its own stays as it is.
function packagePath(template: string | undefined, descriptor: PackageDescriptor): string {
  if (!template || /^[a-z][a-z0-9+.-]*:/i.test(descriptor.base)) return descriptor.base;
  const path = template
    .replaceAll('{name}', descriptor.name)
    .replaceAll('{version}', descriptor.version);
  return path.endsWith('/') ? path : `${path}/`;
}

// Bridge mode for these packages: the manifest's packages and recordings
// with their bases where this page serves them, and the bridge: the table
// of its paths (the frames' pages, worker scripts and imports, which load
// by URL from their own origin) and where each comes from. A sandbox's
// own: another create() on the page has another.
export async function useBridge(
  options: { domain: string; content?: string; worker?: string; packagePath?: string },
  runtimePath: string,
  packages: PackageDescriptor[],
  boot: Boot | null,
  services: BridgeTable['services'],
): Promise<{ packages: PackageDescriptor[]; boot: Boot | null; bridge: Bridge }> {
  const content = contentDirectory(options.content ?? contentPath());
  const runtimeUrl = belowContent(content, runtimePath);
  // The runtime's path below the bridge names the runtime the page serves
  // (its package.json), wherever the page serves it: the service worker
  // knows a Node.js process's worker by it.
  const host = await runtimeHost(runtimeUrl.href).catch((error: Error) => {
    throw Object.assign(new Error(`the runtime did not load: ${error.message}`), {
      code: 'ERUNTIME',
    });
  });
  const runtime = below(host.name, host.version);
  const sources: [string, string][] = [[runtime, runtimeUrl.href]];
  const paths = new Map<string, string>();
  // The exec frame's workers read the files where this page serves them,
  // with CORS: past the service worker and this page's worker, which are
  // slower and, in Firefox and WebKit, held up by a busy page
  // (docs/bridge-report.md). A package's pages (claude.html) and scripts
  // are below the bridge. Files served over http to https frames are
  // read below the bridge too: WebKit blocks them as mixed content, even
  // on *.localhost (docs/frames.md, "Schemes").
  const direct = !(
    new URL(content).protocol === 'http:' && domainScheme(options.domain) === 'https:'
  );
  const bridged = packages.map((descriptor) => {
    const path = below(descriptor.name, descriptor.version);
    const url = belowContent(content, packagePath(options.packagePath, descriptor)).href;
    paths.set(descriptor.name, path);
    sources.push([path, url]);
    return { ...descriptor, base: direct ? url : path };
  });
  let recordings = boot;
  if (boot) {
    const url = belowContent(content, boot.base).href;
    sources.push(['boot/', url]);
    recordings = { ...boot, base: direct ? url : 'boot/' };
  }
  sources.sort(([a], [b]) => b.length - a.length);
  const bridge: Bridge = {
    domain: options.domain,
    content,
    table: {
      sources,
      // The frames' site: this page is their apex, and their only parent.
      // Each with its scheme where the frames would not take it.
      config: { domain: domainName(location.host), usercontent: domainName(options.domain) },
      services,
      // A Node.js process reads the tls package's files from there.
      connect: [...new Set(sources.map(([, url]) => url))],
      ...(options.worker ? { worker: options.worker } : {}),
    },
    runtime,
    runtimeUrl: runtimeUrl.href,
    host,
    packages: paths,
  };
  return { packages: bridged, boot: recordings, bridge };
}

// The runtime the page serves, as the load-time check needs it: its
// version and seams from its own package.json (`playground.provides`, the
// published package's), not this api's build of them, which may be an
// older minor. A package.json without `provides` (a workspace's) has this
// build's seams. By URL, once.
const hosts = new Map<string, Promise<Host>>();
export function runtimeHost(runtimeUrl: string): Promise<Host> {
  let known = hosts.get(runtimeUrl);
  if (!known) {
    known = fetch(new URL('package.json', runtimeUrl)).then(async (response) => {
      if (!response.ok) throw new Error(`${runtimeUrl}package.json: ${response.status}`);
      const pkg = await response.json();
      if (pkg.name !== HOST.name || typeof pkg.version !== 'string')
        throw new Error(`${runtimeUrl} is no ${HOST.name}`);
      return {
        name: pkg.name,
        version: pkg.version,
        provides: pkg.playground?.provides ?? HOST.provides,
      };
    });
    known.catch(() => hosts.delete(runtimeUrl));
    hosts.set(runtimeUrl, known);
  }
  return known;
}

// What a frame other than the exec frame's worker may ask for: files, no
// services.
export const frameTable = (table: BridgeTable): BridgeTable => ({ ...table, services: null });
