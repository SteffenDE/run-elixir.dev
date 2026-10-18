// The site's templates (fs/templates.json, from runtime/build.py): for
// each kind that has one, its id (a digest of its files, without its
// build) and what it is. A project notes the template it was made from,
// so a project made from another one can say so.
import type { Kind } from './projects';
import { RUNTIME } from './build';

export interface Template {
  id: string;
  label: string;
}

let templates: Promise<Partial<Record<Kind, Template>>> | null = null;

export function siteTemplate(kind: Kind): Promise<Template | null> {
  templates ??= fetch(`${RUNTIME}fs/templates.json`)
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  return templates.then((all) => all[kind] ?? null);
}
