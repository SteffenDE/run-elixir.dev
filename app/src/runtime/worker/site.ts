import { register } from '../coreutils';
import { Site, type SiteRef } from '../packages/manifest';

// A path in the build this worker came from (b/ID/, build.py), or on the
// site for an absolute one. Through a variable: Vite takes
// new URL('…', import.meta.url) with the path written out for an asset of
// the bundle. Only the worker's entry imports this: in a chunk of its own,
// import.meta.url would name the chunk.
export const site = (path: string) => new URL(path, import.meta.url);

// The site's packages (the site manifest, site.json: docs/packages.md),
// which name the BEAM, the fs image, the programs and the NIF libraries;
// the page names it as the node starts.
let packages: Site | null = null;
export function artifacts(): Site {
  if (!packages) throw new Error('no site manifest yet');
  return packages;
}
export function setSite(ref: SiteRef): void {
  packages = new Site(ref);
  register(packages.programs());
}
