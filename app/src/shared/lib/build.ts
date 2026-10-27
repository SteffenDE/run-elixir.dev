import { loadManifest, type SiteRef } from '@/runtime/packages/manifest';

// Where this page's build keeps its runtime, files and WebAssembly:
// /b/ID/, which runtime/build.py names in each page's
// <meta name="playground-build">. A page loaded before a deploy keeps
// loading its own build's files, never a newer one's. Without it (a site
// laid out flat), the root.
const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
const id = meta('playground-build');
export const BUILD = id ? `/b/${id}/` : '/';
// Where its BEAM, files and NIF libraries are: /r/RID/ (<meta
// name="playground-runtime">), which changes only with them, so a deploy
// of the JavaScript alone leaves them cached. Without it, the build's.
const runtime = meta('playground-runtime');
export const RUNTIME = runtime ? `/r/${runtime}/` : BUILD;
// The site manifest (runtime/build.py's site.json, docs/packages.md): the
// packages this page's runtime runs with, and where their files are.
export const SITE = `${RUNTIME}site.json`;

let site: Promise<SiteRef> | null = null;
export function siteManifest(): Promise<SiteRef> {
  site ??= loadManifest(new URL(SITE, location.href));
  return site;
}
