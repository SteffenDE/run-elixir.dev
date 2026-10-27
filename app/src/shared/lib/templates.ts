// The site's templates (their packages' `playground` field, site.json):
// for each kind that has one, its id (a digest of its files, without its
// build) and what it is. A project notes the template it was made from,
// so a project made from another one can say so.
import type { Kind } from './projects';
import { siteManifest } from './build';
import { Site } from '@/runtime/packages/manifest';

export interface Template {
  id: string;
  label: string;
}

export function siteTemplate(kind: Kind): Promise<Template | null> {
  return siteManifest()
    .then((ref) => new Site(ref).template(kind))
    .catch(() => null);
}
