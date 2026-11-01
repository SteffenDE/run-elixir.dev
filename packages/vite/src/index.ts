// @elixir-playground/vite (docs/api.md): what a site that runs projects
// with create() serves besides its own pages.
//
//   // vite.config.ts
//   import { elixirPlayground } from '@elixir-playground/vite';
//   export default defineConfig({ plugins: [elixirPlayground()] });
//
// The site's pages (the apex) import @elixir-playground/api and the
// packages like any dependency. Project code runs on a shared usercontent
// domain (docs/frames.md), which serves no packages: they are the apex's
// own files, below Vite's `base` (npm/NAME@VERSION/, NAME with its scope if it has one,
// where their descriptors' `base` points), which `vite build` puts in its
// output and `vite` serves. The pages get <meta name="playground-runtime">
// and <meta name="playground-content">, which create() reads by default.
//
// `usercontent` names the shared domain: in the pages' /playground.json,
// which create() reads by default (run-elixir.dev's without). A
// `*.localhost` one is the plugin's to answer in `vite` and `vite
// preview` (its bootstrap, service worker and bridge.json), for local
// work.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface Options {
  // The shared usercontent domain, with a port if any: its subdomains run
  // project code. Named in the pages' /playground.json; without, create()
  // takes run-elixir.dev's. A `*.localhost` one
  // ('usercontent.localhost:5173', http) `vite` and `vite preview` answer.
  // With a scheme ('https://usercontent.example'), its origins have it;
  // without, they are https but for a local one (docs/frames.md, "Schemes").
  usercontent?: string;
  // Packages that are not installed, by directory (a template package of
  // the site's own, say): laid out as the installed ones are.
  packages?: string[];
}

const SCOPE = '@elixir-playground';

// The shared domain's host, without the scheme it may be written with.
const hostOf = (domain: string) => domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').toLowerCase();

interface Found {
  name: string;
  version: string;
  directory: string;
}

// The packages to serve: the runtime and every one with a `playground`
// field, of any scope or none, installed below `root` (its node_modules
// and its parents', as a workspace hoists them), the first of each name.
export function findPackages(root: string, extra: string[] = []): Found[] {
  const found = new Map<string, Found>();
  const take = (directory: string) => {
    const file = join(directory, 'package.json');
    if (!existsSync(file)) return;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const served =
      manifest.name === `${SCOPE}/runtime` ||
      (typeof manifest.playground === 'object' && manifest.playground !== null);
    if (!served || manifest.private || found.has(manifest.name)) return;
    found.set(manifest.name, { name: manifest.name, version: manifest.version, directory });
  };
  for (const directory of extra) take(resolve(root, directory));
  for (let at = resolve(root); ; at = dirname(at)) {
    const modules = join(at, 'node_modules');
    if (existsSync(modules))
      for (const name of readdirSync(modules).sort()) {
        if (name.startsWith('.')) continue;
        if (!name.startsWith('@')) take(join(modules, name));
        else
          for (const each of readdirSync(join(modules, name)).sort())
            take(join(modules, name, each));
      }
    if (dirname(at) === at) break;
  }
  if (!found.has(`${SCOPE}/runtime`))
    throw new Error(`${SCOPE}/vite: ${SCOPE}/runtime is not installed (npm install ${SCOPE}/api)`);
  return [...found.values()];
}

// A package's path on the usercontent domain (its descriptor's `base`).
const base = ({ name, version }: Found) => `/npm/${name}@${version}/`;

// A shared usercontent domain's bootstrap (bridge mode), as the runtime
// package has it: served only on that domain's hosts (docs/frames.md, "Who
// may bridge"), never among the packages' files.
const BOOTSTRAP = join('root', 'bridge.html');

// The packages, each at its path (`base`), below `out`.
function copyPackages(out: string, packages: Found[]): void {
  for (const found of packages)
    cpSync(found.directory, join(out, base(found)), {
      recursive: true,
      dereference: true,
      // Not a package's own dependencies, nor the bootstrap.
      filter: (source) => {
        const path = relative(found.directory, source);
        return !path.split(sep).includes('node_modules') && path !== BOOTSTRAP;
      },
    });
}

// The packages in the apex's output (`out`, Vite's outDir), below npm/
// (emptied first); the runtime's path.
export function writeApexPackages(out: string, root: string, options: Options): string {
  const packages = findPackages(root, options.packages);
  rmSync(join(out, 'npm'), { recursive: true, force: true });
  copyPackages(out, packages);
  return base(packages.find(({ name }) => name === `${SCOPE}/runtime`)!);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.pem': 'application/x-pem-file',
};

// A file's bytes with its type, or a 404; `headers` on either.
function sendFile(
  response: ServerResponse,
  file: string | null,
  sent: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(sent)) response.setHeader(name, value);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.end(readFileSync(file));
}

// Locally: a request to the shared usercontent domain's hosts, answered
// with the runtime's bootstrap and service worker, and /bridge.json naming
// the domain, and nothing else (as a shared domain answers). False for
// another host's.
function serveBridge(
  packages: () => Found[],
  options: Options,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const host = (request.headers.host ?? '').toLowerCase();
  const domain = options.usercontent && hostOf(options.usercontent);
  if (!domain || !host.endsWith(`.${domain}`)) return false;
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  if (path === '/bridge.json') {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Cache-Control', 'no-cache');
    response.end(JSON.stringify({ bridge: domain }));
    return true;
  }
  const runtime = packages().find(({ name }) => name === `${SCOPE}/runtime`)!;
  const file = ['/bridge.html', '/sw.js'].includes(path)
    ? join(runtime.directory, 'root', path.slice(1))
    : null;
  sendFile(response, file, {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-cache',
  });
  return true;
}

// The packages' files are read by the frames' workers, on
// the shared domain's origins (one per project): CORS for any origin, and
// CORP for another site.
const PUBLIC = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// In dev: the apex's npm/NAME@VERSION/
// below Vite's base (`prefix`), from the installed packages. False for
// another path.
function serveApexPackage(
  packages: () => Found[],
  prefix: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  if (!pathname.startsWith(`${prefix}npm/`)) return false;
  const path = pathname.slice(prefix.length - 1);
  const found = packages().find((each) => path.startsWith(base(each)));
  const file = found ? normalize(join(found.directory, path.slice(base(found).length))) : null;
  const served = file && found && file.startsWith(found.directory) ? file : null;
  sendFile(response, served && relative(found!.directory, served) !== BOOTSTRAP ? served : null, {
    ...PUBLIC,
    'Cache-Control': 'no-cache',
  });
  return true;
}

export function elixirPlayground(options: Options = {}): Plugin {
  let root = process.cwd();
  // The installed packages, found once (the dev server answers each file).
  let found: Found[] | null = null;
  const packages = () => (found ??= findPackages(root, options.packages));
  let apexOut = '';
  let runtime = '';
  // Vite's base, which the packages are below (create()'s
  // usercontent.content by default), and its path, which dev and preview
  // answer them at.
  let content = '/';
  let prefix = '/';
  const tag = (name: string, value: string) => ({
    tag: 'meta',
    attrs: { name, content: value },
    injectTo: 'head' as const,
  });
  const meta = () => [
    tag('playground-runtime', runtime),
    tag('playground-content', content),
    ...(options.usercontent ? [tag('playground-usercontent', options.usercontent)] : []),
  ];
  // The shared domain's hosts, which dev and preview answer, locally.
  const name = options.usercontent && hostOf(options.usercontent).split(':')[0];
  const local = name ? name.endsWith('localhost') : false;
  return {
    name: 'elixir-playground',
    config: () => ({
      ...(local
        ? {
            server: { allowedHosts: [`.${name}`] },
            preview: { allowedHosts: [`.${name}`] },
          }
        : {}),
      // The api starts its apex worker from its own directory
      // (apexWorker.js): left as installed, not pre-bundled.
      optimizeDeps: { exclude: [`${SCOPE}/api`] },
    }),
    configResolved(config) {
      root = config.root;
      apexOut = resolve(root, config.build.outDir);
      content = config.base || './';
      prefix = config.base.startsWith('/') ? config.base : '/';
      if (/^https?:/.test(config.base)) prefix = new URL(config.base).pathname;
      if (!prefix.endsWith('/')) prefix += '/';
      runtime = base(
        findPackages(root, options.packages).find(({ name }) => name === `${SCOPE}/runtime`)!,
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (local && serveBridge(packages, options, request, response)) return;
        // The apex: cross-origin isolated, as create() needs.
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        if (serveApexPackage(packages, prefix, request, response)) return;
        next();
      });
    },
    // `vite preview`: the built output, as dev serves it.
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (local && serveBridge(packages, options, request, response)) return;
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        if (request.url?.startsWith(`${prefix}npm/`))
          for (const [name, value] of Object.entries(PUBLIC)) response.setHeader(name, value);
        next();
      });
    },
    transformIndexHtml: () => meta(),
    closeBundle() {
      writeApexPackages(apexOut, root, options);
    },
  };
}

export default elixirPlayground;
