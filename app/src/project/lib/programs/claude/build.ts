// Claude Code's files for the playground's Node, made in the claude
// frame's worker (worker.ts, on claude.USERCONTENT: an origin of its own,
// shared by every project of this browser, which runs none of it). Its npm
// package is a Bun executable (Bun's runtime with Claude Code's JavaScript
// in it): the worker fetches the version below from the npm registry,
// checks it against its integrity, reads the JavaScript out of the
// executable (bungraph.ts) and compiles it, keeping the result in its
// origin's IndexedDB (and dropping other versions').
//
// The version is one the playground was tried with: a new one may lean
// on Bun's APIs further, or be built by a Bun whose module graph reads
// otherwise. Update it with the site.
import { sha512 } from '@noble/hashes/sha2.js';
import { graphParts, type GraphFile } from './bungraph';
import { load as loadEsbuild } from '../esbuild';

export const CLAUDE_CODE = {
  version: '2.1.306',
  // @anthropic-ai/claude-code-linux-x64's: the playground's Node says linux on x64.
  tarball:
    'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.306.tgz',
  integrity:
    'sha512-4gsb0IQhxzi1NhoUETXkNZb1t6wJ9tnfAYBKmb0+NmsAwOG37Dacq7bLqsooEkusaT0PyQRFUMt0SgWxx9LEEA==',
  // The executable, in the tarball.
  binary: 'package/claude',
};

const DATABASE = 'playground-claude-code';
// Cache format version. Increment when the generated output changes to
// invalidate cached files.
const LAYOUT = 4;
const STORE = 'versions';
// Where a project's files.js holds them, by version (claude.ts).
export const DIR = '/opt/claude-code';
const MB = 1 << 20;

// Packages Bun has built in, which the modules import by name: ws (for
// features the playground has no use for: a stub that says so) and
// node-fetch (Node's fetch).
const BUILT_IN: GraphFile[] = [
  {
    name: 'node_modules/ws/index.js',
    data: new TextEncoder().encode(
      "class WebSocket { constructor() { throw new Error('ws: not in the playground'); } }\n" +
        'module.exports = WebSocket;\nmodule.exports.WebSocket = WebSocket;\n' +
        'module.exports.WebSocketServer = WebSocket;\n',
    ),
  },
  { name: 'package.json', data: new TextEncoder().encode('{"type":"commonjs"}\n') },
  {
    name: 'node_modules/node-fetch/index.js',
    data: new TextEncoder().encode(
      'module.exports = (...args) => fetch(...args);\nmodule.exports.default = module.exports;\n' +
        'Object.assign(module.exports, { Headers, Request, Response });\n',
    ),
  },
];

// Its modules as CommonJS (esbuild-wasm's transform, each on its own:
// the whole graph at once is more than its memory), so the playground's
// Node loads them without compiling them each run. esbuild's exports are
// getters set before a module's imports run, so modules that import each
// other in a cycle find each other's functions, as ES modules do. A
// module's require as Bun's (nodejs/claude/bun.ts: a text file's contents), and
// Bun's import.meta as a CommonJS module has it.
async function compile(
  modules: Map<string, string>,
  say: (text: string) => void,
): Promise<GraphFile[]> {
  const esbuild = await loadEsbuild();
  const encoder = new TextEncoder();
  const names = [...modules.keys()];
  const files: GraphFile[] = [];
  let shown = -1;
  for (let at = 0; at < names.length; at += 32) {
    const batch = names.slice(at, at + 32);
    const compiled = await Promise.all(
      batch.map((name) =>
        esbuild.transform(modules.get(name)!, {
          loader: 'js',
          format: 'cjs',
          platform: 'node',
          target: 'es2022',
          sourcefile: `${DIR}/${name}`,
          minifyWhitespace: true,
          logLevel: 'silent',
          banner:
            'require=globalThis.__bunRequire(require);' +
            'var __bunImportMetaUrl=require("url").pathToFileURL(__filename).href;',
          define: {
            'import.meta.url': '__bunImportMetaUrl',
            'import.meta.dirname': '__dirname',
            'import.meta.filename': '__filename',
          },
        }),
      ),
    );
    batch.forEach((name, i) => files.push({ name, data: encoder.encode(compiled[i].code) }));
    const percent = Math.floor((files.length / names.length) * 10) * 10;
    if (percent > shown) say(`\rclaude: compiling its modules ${(shown = percent)}%`);
  }
  say('\n');
  return files;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function database(): Promise<IDBDatabase> {
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

// The version's files, as kept; null if they are not.
async function kept(version: string): Promise<GraphFile[] | null> {
  const db = await database();
  try {
    const store = db.transaction(STORE).objectStore(STORE);
    return ((await request(store.get(version))) as GraphFile[] | undefined) ?? null;
  } finally {
    db.close();
  }
}

// Keep `files` as `version`'s, and only those.
async function keep(version: string, files: GraphFile[]): Promise<void> {
  const db = await database();
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const key of await request(store.getAllKeys())) if (key !== version) store.delete(key);
    await request(store.put(files, version));
  } finally {
    db.close();
  }
}

// The executable from the registry's tarball: downloaded and hashed as it
// comes, gunzipped, and read as a tar for the one file.
async function fetchBinary(say: (text: string) => void): Promise<Uint8Array> {
  const response = await fetch(CLAUDE_CODE.tarball);
  if (!response.ok || !response.body)
    throw new Error(`${CLAUDE_CODE.tarball} answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = sha512.create();
  let received = 0;
  let shown = -1;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        hash.update(chunk);
        received += chunk.length;
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (total && percent >= shown + 10) {
          shown = percent - (percent % 10);
          say(
            `\rclaude: downloading Claude Code ${CLAUDE_CODE.version} (${Math.round(total / MB)} MB) ${shown}%`,
          );
        }
        controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
      },
    }),
  );
  const tar = counted.pipeThrough(new DecompressionStream('gzip')).getReader();
  const binary = await untarOne(tar, CLAUDE_CODE.binary);
  say('\n');
  const digest = hash.digest();
  let base64 = '';
  for (const byte of digest) base64 += String.fromCharCode(byte);
  if (`sha512-${btoa(base64)}` !== CLAUDE_CODE.integrity)
    throw new Error(`${CLAUDE_CODE.tarball}: does not match its integrity`);
  if (!binary) throw new Error(`${CLAUDE_CODE.tarball}: has no ${CLAUDE_CODE.binary}`);
  return binary;
}

// A tar's file named `want`, read from its stream (the rest read through,
// so the stream ends and its hash is whole); null if it has none.
async function untarOne(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  want: string,
): Promise<Uint8Array | null> {
  let buffered = new Uint8Array(0);
  let done = false;
  // At least `n` bytes buffered, unless the stream ends first.
  const fill = async (n: number) => {
    while (buffered.length < n && !done) {
      const next = await reader.read();
      if (next.done) done = true;
      else {
        const joined = new Uint8Array(buffered.length + next.value.length);
        joined.set(buffered);
        joined.set(next.value, buffered.length);
        buffered = joined;
      }
    }
  };
  const text = (bytes: Uint8Array) => {
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
  };
  let found: Uint8Array | null = null;
  let longName: string | null = null;
  for (;;) {
    await fill(512);
    if (buffered.length < 512 || buffered[0] === 0) break;
    const header = buffered.subarray(0, 512);
    const prefix = text(header.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/` : '') + text(header.subarray(0, 100));
    longName = null;
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    buffered = buffered.slice(512);
    const padded = Math.ceil(size / 512) * 512;
    // The body: copied out in pieces as it comes for the one wanted (no
    // buffer of the whole tar), else read through.
    const body = name === want && (type === '0' || type === '\0') ? new Uint8Array(size) : null;
    const small = type === 'x' || type === 'L' ? new Uint8Array(size) : null;
    let at = 0;
    while (at < padded) {
      await fill(1);
      if (!buffered.length) throw new Error('the tarball ends early');
      const take = Math.min(buffered.length, padded - at);
      const piece = buffered.subarray(0, Math.min(take, Math.max(0, size - at)));
      (body ?? small)?.set(piece, at);
      at += take;
      buffered = buffered.slice(take);
    }
    if (type === 'L' && small) longName = text(small);
    if (type === 'x' && small) {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(small));
      if (path) longName = path[1];
    }
    if (body) found = body;
  }
  while (!done) {
    const next = await reader.read();
    done = next.done;
  }
  return found;
}

// The version's files: kept, else made (and kept).
export async function claudeFiles(say: (text: string) => void): Promise<GraphFile[]> {
  const version = `${CLAUDE_CODE.version}/${LAYOUT}`;
  const files = await kept(version).catch(() => null);
  if (files) return files;
  const binary = await fetchBinary(say);
  say(`claude: reading Claude Code's JavaScript out of its executable\n`);
  const { modules, assets } = graphParts(binary);
  const made = [...assets, ...BUILT_IN, ...(await compile(modules, say))];
  await keep(version, made).catch((error: Error) =>
    say(`claude: could not keep it for the next run (${error.message})\n`),
  );
  return made;
}
