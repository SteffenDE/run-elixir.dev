// The packages' surface (src/sdk/, docs/packages.md): a package's code
// imports the runtime only from there, so what it bundles of the runtime
// is what a seam versions. The api is the runtime's own other half (its
// major: docs/packages.md, "process API") and is not held to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const PACKAGES = join(__dirname, '../../..');
// Packages that ship code to sites, other than the runtime and the api.
const CHECKED = ['claude', 'nodejs'];
// Until the esbuild package (it is the runtime's program today).
const ALLOWED = new Set(['programs/esbuild']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

it('keeps the packages’ code to the runtime’s sdk/', () => {
  const outside: string[] = [];
  for (const pkg of CHECKED)
    for (const dir of ['src', 'test'])
      for (const file of sources(join(PACKAGES, pkg, dir)))
        for (const [, module] of readFileSync(file, 'utf8').matchAll(
          /['"]@elixir-playground\/runtime\/([^'"]+)['"]/g,
        ))
          if (!module.startsWith('sdk/') && !ALLOWED.has(module))
            outside.push(`${file.slice(PACKAGES.length + 1)}: ${module}`);
  expect(outside).toEqual([]);
});
