// What a Vite build bundles from node_modules, and under which licenses
// (docs/licenses.md): dist-licenses/NAME.json, which runtime/build.py
// turns into the packages' licenses/ and the site's licenses page. Each
// package once: its name, version, license (package.json's SPDX
// expression) and its license files' texts. The build fails on a package
// whose package.json names no license.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|patents)([-._].*)?$/i;
const CODE = /\.(js|mjs|cjs|ts|d\.ts|map|json)$/;
const VITE = new URL('./node_modules/vite', import.meta.url).pathname;

interface Component {
  name: string;
  version: string;
  license: string;
  url: string;
  texts: Record<string, string>;
}

// The package directory a module is from: the last node_modules/NAME (or
// node_modules/@SCOPE/NAME) in its path.
function packageDirectory(id: string): string | null {
  const path = id.replace(/^\0+/, '').split('?')[0];
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  return path.slice(0, at) + '/node_modules/' + name;
}

function describe(directory: string): Component | string {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  let license: string | undefined =
    typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  if (!license && Array.isArray(manifest.licenses)) {
    license = manifest.licenses.map((entry: { type: string }) => entry.type).join(' OR ');
  }
  if (!license) return `${manifest.name}@${manifest.version}: package.json names no license`;
  const texts: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (LICENSE_FILE.test(name) && !CODE.test(name) && statSync(path).isFile()) {
      texts[name] = readFileSync(path, 'utf8');
    }
  }
  const repository =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const url =
    manifest.homepage ??
    repository?.replace(/^git\+/, '').replace(/\.git$/, '') ??
    `https://www.npmjs.com/package/${manifest.name}`;
  return { name: manifest.name, version: manifest.version, license, url, texts };
}

// The plugins for a build named `name`: one for the build itself and one
// for its workers' (Vite builds those apart), which share what they find.
export function licenses(name: string): { plugin: Plugin; worker: () => Plugin[] } {
  const directories = new Set<string>();
  const collect = (): Plugin => ({
    name: 'playground-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const ids = new Set<string>(this.getModuleIds());
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of output.moduleIds) ids.add(id);
      }
      for (const id of ids) {
        // Vite's own helpers in the bundle (\0vite/preload-helper and the like).
        const directory = id.startsWith('\0vite/') ? VITE : packageDirectory(id);
        if (directory) directories.add(directory);
      }
    },
  });
  const plugin: Plugin = {
    ...collect(),
    closeBundle() {
      const components: Component[] = [];
      const problems: string[] = [];
      for (const directory of [...directories].sort()) {
        if (!existsSync(join(directory, 'package.json'))) continue;
        const found = describe(directory);
        if (typeof found === 'string') problems.push(found);
        else if (!components.some((c) => c.name === found.name && c.version === found.version)) {
          components.push(found);
        }
      }
      if (problems.length) throw new Error(`licenses:\n  ${problems.join('\n  ')}`);
      components.sort((a, b) => a.name.localeCompare(b.name));
      const out = new URL('./dist-licenses/', import.meta.url).pathname;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${name}.json`), JSON.stringify({ format: 1, components }, null, 1));
    },
  };
  return { plugin, worker: () => [collect()] };
}
