// A package's `layer` (types.ts Playground): an fs layer the site's build
// made, read into the package's `fs`, its paths then relative to the
// package's base as a site manifest has them.
import type { FsLayer, PackageEntry } from './types';

// `entry` with its `layer` read (`load`: the JSON at a path below its
// base), or as it is without one.
export async function withLayer<T extends PackageEntry>(
  entry: T,
  load: (path: string) => Promise<FsLayer>,
): Promise<T> {
  const path = entry.playground.layer;
  if (!path || entry.playground.fs) return entry;
  const layer = await load(path);
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const { layer: _, ...playground } = entry.playground;
  return {
    ...entry,
    playground: {
      ...playground,
      fs: {
        ...layer,
        manifest: directory + layer.manifest,
        bundles: directory + layer.bundles,
      },
    },
  };
}
