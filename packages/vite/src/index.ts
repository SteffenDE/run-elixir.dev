// @elixir-playground/vite (docs/api.md): what a site that runs projects
// with create() serves besides its own pages.
//
//   // vite.config.ts
//   import { elixirPlayground } from '@elixir-playground/vite';
//   export default defineConfig({
//     plugins: [elixirPlayground({ apex: 'example.com', usercontent: 'example-usercontent.com' })],
//   });
//
// The site's pages (the apex) import @elixir-playground/api and the
// packages like any dependency. Project code runs on a second registrable
// domain, the usercontent domain (docs/frames.md), which serves:
//
// - the runtime package and every installed package with a `playground`
//   field, at /npm/@elixir-playground/NAME@VERSION/ (where their
//   descriptors' `base` points);
// - the runtime's service worker (/sw.js) and its /relay.html bootstrap;
// - /playground.json, naming the apex as the frames' parent;
// - _headers: the isolation headers, caching, and the Node.js worker's
//   policy (Netlify and Cloudflare Pages read it; docs/deploy.md has
//   Caddy's).
//
// `vite build` writes that folder (outDir, dist-usercontent/ by default)
// for the second site, and gives the apex /playground.json and its pages
// <meta name="playground-runtime">, which create() reads by default. `vite`
// (dev) serves the usercontent domain's hosts itself, and sends the
// isolation headers create() needs.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface Options {
  // The usercontent domain, with a port if any ('example-usercontent.com',
  // 'usercontent.localhost:5173'): its subdomains run project code.
  usercontent: string;
  // The site's own host, with a port if any: the usercontent domain's
  // frames take calls from its pages. In dev, the dev server's by default.
  apex?: string;
  // Other sites whose pages may run projects on this usercontent domain.
  embedders?: string[];
  // Packages that are not installed, by directory (a template package of
  // the site's own, say): laid out as the installed ones are.
  packages?: string[];
  // Where `vite build` writes the usercontent domain's files, relative to
  // the project's root.
  outDir?: string;
  // The usercontent domain's scheme, for the Node.js worker's policy.
  https?: boolean;
}

const SCOPE = '@elixir-playground';

interface Found {
  name: string;
  version: string;
  directory: string;
}

// The packages to serve: the runtime and every one with a `playground`
// field, installed below `root` (its node_modules and its parents', as a
// workspace hoists them), the first of each name.
export function findPackages(root: string, extra: string[] = []): Found[] {
  const found = new Map<string, Found>();
  const take = (directory: string) => {
    const file = join(directory, 'package.json');
    if (!existsSync(file)) return;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const served = manifest.name === `${SCOPE}/runtime` || manifest.playground !== undefined;
    if (!served || manifest.private || found.has(manifest.name)) return;
    found.set(manifest.name, { name: manifest.name, version: manifest.version, directory });
  };
  for (const directory of extra) take(resolve(root, directory));
  for (let at = resolve(root); ; at = dirname(at)) {
    const scope = join(at, 'node_modules', SCOPE);
    if (existsSync(scope)) for (const name of readdirSync(scope).sort()) take(join(scope, name));
    if (dirname(at) === at) break;
  }
  if (!found.has(`${SCOPE}/runtime`))
    throw new Error(`${SCOPE}/vite: ${SCOPE}/runtime is not installed (npm install ${SCOPE}/api)`);
  return [...found.values()];
}

// A package's path on the usercontent domain (its descriptor's `base`).
const base = ({ name, version }: Found) => `/npm/${name}@${version}/`;

// The headers the usercontent domain sends (_headers' format: a path,
// then its headers indented). The Node.js worker's policy names its own
// scripts and the packages' files (docs/nodejs.md, The worker's policy).
export function headers(options: Options, runtime: string): string {
  const scheme = options.https === false ? 'http' : 'https';
  const origin = `${scheme}://*.${options.usercontent}`;
  const scripts = `${origin}${runtime}nodejs.js ${origin}${runtime}chunks/`;
  const policy =
    `default-src 'none'; script-src ${scripts} 'unsafe-eval' 'wasm-unsafe-eval'; ` +
    `worker-src ${scripts} blob:; connect-src ${origin}/npm/${SCOPE}/ data: blob:`;
  return [
    '/*',
    '  Cross-Origin-Embedder-Policy: require-corp',
    '  Cross-Origin-Resource-Policy: cross-origin',
    '/npm/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/sw.js',
    '  Cache-Control: no-cache',
    '/relay.html',
    '  Cache-Control: no-cache',
    '/playground.json',
    '  Cache-Control: no-cache',
    `${runtime}nodejs.js`,
    `  Content-Security-Policy: ${policy}`,
    `${runtime}chunks/*`,
    `  Content-Security-Policy: ${policy}`,
    '',
  ].join('\n');
}

// The usercontent domain's files, into `out` (emptied first).
export function writeUsercontent(
  out: string,
  root: string,
  options: Options,
  apex: string,
): string {
  const packages = findPackages(root, options.packages);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const found of packages)
    cpSync(found.directory, join(out, base(found)), {
      recursive: true,
      dereference: true,
      // Not a package's own dependencies.
      filter: (source) => !relative(found.directory, source).split(sep).includes('node_modules'),
    });
  const runtime = packages.find(({ name }) => name === `${SCOPE}/runtime`)!;
  for (const file of ['sw.js', 'relay.html'])
    cpSync(join(runtime.directory, 'root', file), join(out, file));
  writeFileSync(
    join(out, 'playground.json'),
    JSON.stringify({
      domain: apex,
      usercontent: options.usercontent,
      embedders: options.embedders ?? [],
    }),
  );
  writeFileSync(join(out, '_headers'), headers(options, base(runtime)));
  return base(runtime);
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

// A request to one of the usercontent domain's hosts, answered from `out`
// with the headers _headers names. False for another host's.
function serveUsercontent(
  out: string,
  options: Options,
  runtime: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const host = (request.headers.host ?? '').toLowerCase();
  if (!host.endsWith(`.${options.usercontent.toLowerCase()}`)) return false;
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const file = normalize(join(out, path));
  if (!file.startsWith(out) || !existsSync(file) || !statSync(file).isFile()) {
    response.statusCode = 404;
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.end();
    return true;
  }
  response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Cache-Control', 'no-cache');
  if (path === `${runtime}nodejs.js` || path.startsWith(`${runtime}chunks/`)) {
    const policy = headers(options, runtime)
      .split('\n')
      .find((line) => line.includes('Content-Security-Policy'));
    response.setHeader('Content-Security-Policy', policy!.split(': ').slice(1).join(': '));
  }
  response.end(readFileSync(file));
  return true;
}

export function elixirPlayground(options: Options): Plugin {
  let root = process.cwd();
  let apex = options.apex ?? '';
  let runtime = '';
  let out = '';
  const meta = () => [
    {
      tag: 'meta',
      attrs: { name: 'playground-runtime', content: runtime },
      injectTo: 'head' as const,
    },
  ];
  const site = () =>
    JSON.stringify({
      domain: apex,
      usercontent: options.usercontent,
      embedders: options.embedders ?? [],
    });
  return {
    name: 'elixir-playground',
    config: () => {
      // The usercontent domain's hosts, which dev and preview answer too,
      // and the apex's.
      const hosts = [`.${options.usercontent.split(':')[0]}`];
      if (options.apex) hosts.push(options.apex.split(':')[0]);
      return { server: { allowedHosts: hosts }, preview: { allowedHosts: hosts } };
    },
    configResolved(config) {
      root = config.root;
      out = resolve(root, options.outDir ?? 'dist-usercontent');
      if (config.command === 'build' && !apex)
        throw new Error(`${SCOPE}/vite: name the site's host (apex) to build`);
      runtime = base(
        findPackages(root, options.packages).find(({ name }) => name === `${SCOPE}/runtime`)!,
      );
    },
    configureServer(server) {
      const port = server.config.server.port ?? 5173;
      apex ||= `localhost:${port}`;
      out = resolve(root, 'node_modules', '.elixir-playground', 'usercontent');
      runtime = writeUsercontent(out, root, { https: false, ...options }, apex);
      server.middlewares.use((request, response, next) => {
        if (serveUsercontent(out, options, runtime, request, response)) return;
        // The apex: cross-origin isolated, and what create() reads.
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        if (request.url?.split('?')[0] === '/playground.json') {
          response.setHeader('Content-Type', 'application/json');
          response.end(site());
          return;
        }
        next();
      });
    },
    // `vite preview`: the built usercontent folder, as dev serves it.
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (serveUsercontent(out, options, runtime, request, response)) return;
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
    transformIndexHtml: () => meta(),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'playground.json', source: site() });
    },
    closeBundle() {
      writeUsercontent(out, root, options, apex);
    },
  };
}

export default elixirPlayground;
