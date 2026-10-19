// Node's built-in modules by name (require('fs'), import 'node:path'),
// each made on first use. What the playground does not have yet (network,
// child processes, compression) is there, and says so when called.
import { Buffer } from './buffer';
import { EventEmitter, once } from 'events';
import * as stream from 'readable-stream';
import { StringDecoder } from 'string_decoder';
import { hashes } from './hashes';
import { createHttp, METHODS, STATUS_CODES } from './http';
import type { Net } from './net';
import { createUtil, inspect, isDeepStrictEqual, types } from './util';

type Factories = Record<string, () => unknown>;

export const BUILTINS = [
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

// A module's calls that the playground lacks: each throws, naming it.
function missing(module: string, names: string[], extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ...extra };
  for (const name of names)
    out[name] = () => {
      const error = new Error(
        `${module}.${name} is not available in the playground yet`,
      ) as Error & { code: string };
      error.code = 'ERR_NOT_AVAILABLE';
      throw error;
    };
  return out;
}

export function createBuiltins(deps: {
  fs: Record<string, unknown>;
  fsPromises: Record<string, unknown>;
  path: Record<string, unknown>;
  process: Record<string, unknown> & EventEmitter;
  console: Record<string, unknown>;
  timers: Record<string, (...args: never[]) => unknown>;
  module: () => Record<string, unknown>;
  env: Record<string, string>;
  tty: boolean;
  // node:wasi (wasi.ts) and worker_threads (threads.ts).
  wasi: () => Record<string, unknown>;
  threads: () => Record<string, unknown>;
  // node:net on the page's TCP (net.ts); a worker thread has none.
  net: Net | null;
}) {
  const { process, timers } = deps;
  const warn = (text: string) => (process.stderr as { write(t: string): void }).write(text);
  const util = createUtil(warn);

  const assert = createAssert();
  // http and https, over the process's net (a thread has none).
  let webModules: ReturnType<typeof createHttp> | null = null;
  const web = () => (deps.net ? (webModules ??= createHttp(deps.net)) : null);

  const factories: Factories = {
    assert: () => assert,
    'assert/strict': () => assert.strict,
    async_hooks: () => {
      class AsyncLocalStorage<T> {
        private store: T | undefined;
        getStore() {
          return this.store;
        }
        run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
          const previous = this.store;
          this.store = store;
          try {
            return fn(...args);
          } finally {
            this.store = previous;
          }
        }
        enterWith(store: T) {
          this.store = store;
        }
        exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
          return this.run(undefined as T, fn, ...args);
        }
        disable() {
          this.store = undefined;
        }
        static bind = <F>(fn: F) => fn;
        static snapshot =
          () =>
          (fn: (...a: unknown[]) => unknown, ...args: unknown[]) =>
            fn(...args);
      }
      class AsyncResource {
        constructor(public type: string) {}
        runInAsyncScope<R>(fn: (...a: unknown[]) => R, self?: unknown, ...args: unknown[]): R {
          return fn.apply(self, args);
        }
        bind<F>(fn: F) {
          return fn;
        }
        emitDestroy() {
          return this;
        }
        asyncId = () => 1;
        triggerAsyncId = () => 0;
        static bind = <F>(fn: F) => fn;
      }
      return {
        AsyncLocalStorage,
        AsyncResource,
        createHook: () => ({
          enable() {
            return this;
          },
          disable() {
            return this;
          },
        }),
        executionAsyncId: () => 1,
        triggerAsyncId: () => 0,
        executionAsyncResource: () => ({}),
      };
    },
    buffer: () => ({
      Buffer,
      Blob,
      File: globalThis.File,
      constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 - 24 },
      kMaxLength: 2 ** 32,
      atob,
      btoa,
      isUtf8: (bytes: Uint8Array) => {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return true;
        } catch {
          return false;
        }
      },
      isAscii: (bytes: Uint8Array) => bytes.every((b) => b < 128),
    }),
    child_process: () =>
      missing('child_process', [
        'spawn',
        'exec',
        'execFile',
        'fork',
        'spawnSync',
        'execSync',
        'execFileSync',
      ]),
    cluster: () => ({
      isPrimary: true,
      isMaster: true,
      isWorker: false,
      workers: {},
      ...missing('cluster', ['fork', 'setupPrimary']),
    }),
    console: () => deps.console,
    constants: () => ({ ...osConstants.signals, ...(deps.fs.constants as object) }),
    crypto: () => createCrypto(),
    dgram: () => missing('dgram', ['createSocket']),
    diagnostics_channel: () => {
      const channel = (name: string) => ({
        name,
        hasSubscribers: false,
        publish() {},
        subscribe() {},
        unsubscribe: () => true,
        bindStore() {},
        unbindStore() {},
        runStores: (
          _data: unknown,
          fn: (...a: unknown[]) => unknown,
          self: unknown,
          ...args: unknown[]
        ) => fn.apply(self, args),
      });
      return {
        channel,
        hasSubscribers: () => false,
        subscribe() {},
        unsubscribe: () => true,
        tracingChannel: (name: string) => ({
          start: channel(`tracing:${name}:start`),
          end: channel(`tracing:${name}:end`),
          asyncStart: channel(`tracing:${name}:asyncStart`),
          asyncEnd: channel(`tracing:${name}:asyncEnd`),
          error: channel(`tracing:${name}:error`),
          hasSubscribers: false,
          subscribe() {},
          unsubscribe() {},
          traceSync: (
            fn: (...a: unknown[]) => unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
          tracePromise: (
            fn: (...a: unknown[]) => unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
          traceCallback: (
            fn: (...a: unknown[]) => unknown,
            _pos: unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
        }),
      };
    },
    dns: () => createDns(),
    'dns/promises': () => createDns().promises,
    events: () => {
      const events = EventEmitter as unknown as Record<string, unknown>;
      events.EventEmitter ??= EventEmitter;
      events.once ??= once;
      events.on ??= on;
      events.setMaxListeners ??= () => {};
      events.getEventListeners ??= (emitter: EventEmitter, name: string) => emitter.listeners(name);
      events.addAbortListener ??= (signal: AbortSignal, fn: () => void) => {
        signal.addEventListener('abort', fn, { once: true });
        return { [Symbol.dispose]: () => signal.removeEventListener('abort', fn) };
      };
      return events;
    },
    fs: () => deps.fs,
    'fs/promises': () => deps.fsPromises,
    http: () =>
      web()?.http ??
      missing('http', ['createServer', 'request', 'get'], {
        STATUS_CODES,
        METHODS,
        Agent,
        globalAgent: {},
      }),
    http2: () => missing('http2', ['createServer', 'connect']),
    https: () =>
      web()?.https ??
      missing('https', ['createServer', 'request', 'get'], { Agent, globalAgent: new Agent() }),
    inspector: () => ({
      url: () => undefined,
      open() {},
      close() {},
      Session: class {
        connect() {}
        post() {}
        disconnect() {}
      },
    }),
    module: () => deps.module(),
    net: () =>
      deps.net?.module ??
      missing('net', ['createServer', 'createConnection', 'connect'], {
        isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(':') ? 6 : 0),
        isIPv4: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
        isIPv6: (s: string) => s.includes(':'),
        Socket: class Socket extends EventEmitter {},
      }),
    os: () => createOs(deps.env),
    path: () => deps.path,
    'path/posix': () => deps.path,
    perf_hooks: () => ({
      performance,
      PerformanceObserver: class {
        observe() {}
        disconnect() {}
      },
      monitorEventLoopDelay: () => ({
        enable() {},
        disable() {},
        percentile: () => 0,
        mean: 0,
        max: 0,
        min: 0,
      }),
      constants: {},
    }),
    process: () => process,
    punycode: () => ({ toASCII: (s: string) => s, toUnicode: (s: string) => s }),
    querystring: () => ({
      parse: (text: string) => Object.fromEntries(new URLSearchParams(text)),
      decode: (text: string) => Object.fromEntries(new URLSearchParams(text)),
      stringify: (object: Record<string, string>) => new URLSearchParams(object).toString(),
      encode: (object: Record<string, string>) => new URLSearchParams(object).toString(),
      escape: encodeURIComponent,
      unescape: decodeURIComponent,
    }),
    readline: () => createReadline(process),
    'readline/promises': () => createReadline(process),
    // Stream, with readable-stream's classes on it as Node's has them (and
    // its own promises, a getter, if it has them).
    stream: () => {
      const out = stream.Stream as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(stream)) if (!(key in out)) out[key] = value;
      if (!('promises' in out)) out.promises = streamPromises();
      return out;
    },
    'stream/promises': () => streamPromises(),
    'stream/web': () => ({
      ReadableStream,
      WritableStream,
      TransformStream,
      TextEncoderStream,
      TextDecoderStream,
    }),
    string_decoder: () => ({ StringDecoder }),
    sys: () => util,
    timers: () => timers,
    'timers/promises': () => ({
      setTimeout: (ms?: number, value?: unknown) =>
        new Promise((resolve) =>
          (timers.setTimeout as (f: () => void, ms?: number) => void)(() => resolve(value), ms),
        ),
      setImmediate: (value?: unknown) =>
        new Promise((resolve) =>
          (timers.setImmediate as (f: () => void) => void)(() => resolve(value)),
        ),
      scheduler: {
        wait: (ms: number) =>
          new Promise((resolve) =>
            (timers.setTimeout as (f: (v?: unknown) => void, ms?: number) => void)(resolve, ms),
          ),
        yield: () =>
          new Promise((resolve) =>
            (timers.setImmediate as (f: (v?: unknown) => void) => void)(resolve),
          ),
      },
    }),
    tls: () =>
      missing('tls', ['connect', 'createServer', 'createSecureContext'], { rootCertificates: [] }),
    tty: () => ({
      isatty: (fd: number) => deps.tty && fd >= 0 && fd <= 2,
      ReadStream: class ReadStream extends EventEmitter {},
      WriteStream: class WriteStream extends EventEmitter {},
    }),
    url: () => createUrl((path) => (deps.path.resolve as (p: string) => string)(path)),
    util: () => util,
    'util/types': () => types,
    v8: () => ({
      getHeapStatistics: () => ({
        total_heap_size: 30e6,
        used_heap_size: 20e6,
        heap_size_limit: 2 ** 31,
        total_available_size: 2 ** 31,
      }),
      getHeapSpaceStatistics: () => [],
      setFlagsFromString() {},
      cachedDataVersionTag: () => 0,
      serialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
      deserialize: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
    }),
    vm: () => createVm(),
    wasi: () => deps.wasi(),
    worker_threads: () => deps.threads(),
    zlib: () =>
      missing(
        'zlib',
        [
          'gzipSync',
          'gunzipSync',
          'deflateSync',
          'inflateSync',
          'createGzip',
          'createGunzip',
          'brotliCompressSync',
          'brotliDecompressSync',
        ],
        { constants: {} },
      ),
  };

  const made = new Map<string, unknown>();
  return (name: string): unknown => {
    if (!made.has(name)) {
      const factory = factories[name];
      if (!factory) throw new Error(`No such built-in module: node:${name}`);
      made.set(name, factory());
    }
    return made.get(name);
  };
}

// dns: the machine's own names (localhost, an address as it is); no
// other name resolves, as nothing outside is reached by name yet.
function createDns() {
  type Found = { address: string; family: number };
  type Options = { family?: number | string; all?: boolean } | number;
  const find = (name: string, options: Options = {}): Found[] => {
    const family =
      typeof options === 'number'
        ? options
        : Number(String(options.family ?? 0).replace('IPv', ''));
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return [{ address: name, family: 4 }];
    if (name.includes(':')) return [{ address: name, family: 6 }];
    if (name === 'localhost' || name.endsWith('.localhost') || !name)
      return family === 6 ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: name,
    });
  };
  const answer = (name: string, options?: Options) => {
    const found = find(name, options);
    return typeof options === 'object' && options.all ? found : found[0];
  };
  const promises = {
    lookup: async (name: string, options?: Options) => answer(name, options),
    resolve: async (name: string) => find(name).map(({ address }) => address),
    resolve4: async (name: string) => find(name, 4).map(({ address }) => address),
    resolve6: async (name: string) => find(name, 6).map(({ address }) => address),
    setDefaultResultOrder() {},
    getDefaultResultOrder: () => 'verbatim',
    setServers() {},
    getServers: () => [],
  };
  const callback =
    (fn: (name: string, options?: Options) => Promise<unknown>) =>
    (
      name: string,
      options?: Options | ((...a: unknown[]) => void),
      done?: (...a: unknown[]) => void,
    ) => {
      if (typeof options === 'function') [done, options] = [options, undefined];
      fn(name, options).then(
        (found) =>
          Array.isArray(found) || typeof found !== 'object' || found === null
            ? done?.(null, found)
            : done?.(null, (found as Found).address, (found as Found).family),
        (error) => done?.(error),
      );
    };
  return {
    lookup: callback(promises.lookup),
    resolve: callback(promises.resolve),
    resolve4: callback(promises.resolve4),
    resolve6: callback(promises.resolve6),
    setDefaultResultOrder() {},
    getDefaultResultOrder: () => 'verbatim',
    setServers() {},
    getServers: () => [],
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    promises,
  };
}

// events.on: an async iterator of an event's arguments.
function on(emitter: EventEmitter, event: string) {
  const queue: unknown[][] = [];
  const waiting: ((value: IteratorResult<unknown[]>) => void)[] = [];
  emitter.on(event, (...args: unknown[]) => {
    const next = waiting.shift();
    if (next) next({ value: args, done: false });
    else queue.push(args);
  });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      queue.length
        ? Promise.resolve({ value: queue.shift()!, done: false })
        : new Promise<IteratorResult<unknown[]>>((resolve) => waiting.push(resolve)),
    return: () => Promise.resolve({ value: undefined, done: true }),
  };
}

function streamPromises() {
  const { pipeline, finished } = stream as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  return {
    pipeline: (...streams: unknown[]) =>
      new Promise((resolve, reject) =>
        pipeline(...streams, (error: unknown) => (error ? reject(error) : resolve(undefined))),
      ),
    finished: (s: unknown, options?: unknown) =>
      new Promise((resolve, reject) =>
        finished(s, options ?? {}, (error: unknown) =>
          error ? reject(error) : resolve(undefined),
        ),
      ),
  };
}

const osConstants = {
  signals: {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGWINCH: 28,
  },
  errno: { ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39 },
  priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -14 },
};

function createOs(env: Record<string, string>) {
  const count = navigator.hardwareConcurrency || 4;
  const cpu = {
    model: 'WebAssembly playground',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return {
    EOL: '\n',
    devNull: '/dev/null',
    constants: osConstants,
    arch: () => 'x64',
    platform: () => 'linux',
    type: () => 'Linux',
    machine: () => 'x86_64',
    release: () => '6.12.0-playground',
    version: () => '#1 SMP',
    hostname: () => 'playground',
    homedir: () => env.HOME ?? '/home/user',
    tmpdir: () => env.TMPDIR ?? '/tmp',
    endianness: () => 'LE',
    cpus: () => Array.from({ length: count }, () => ({ ...cpu })),
    availableParallelism: () => count,
    totalmem: () => 4 * 2 ** 30,
    freemem: () => 2 * 2 ** 30,
    loadavg: () => [0, 0, 0],
    uptime: () => Math.floor(performance.now() / 1000),
    networkInterfaces: () => ({}),
    userInfo: () => ({
      username: env.USER ?? 'user',
      uid: 1000,
      gid: 1000,
      shell: '/bin/sh',
      homedir: env.HOME ?? '/home/user',
    }),
    getPriority: () => 0,
    setPriority: () => {},
  };
}

// resolve(path): an absolute path, as path.resolve makes it.
function createUrl(resolve: (path: string) => string) {
  const fileURLToPath = (url: string | URL) => {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'file:') {
      const error = new TypeError('The URL must be of scheme file') as TypeError & { code: string };
      error.code = 'ERR_INVALID_URL_SCHEME';
      throw error;
    }
    return decodeURIComponent(parsed.pathname);
  };
  // As Node makes it: the path resolved (a trailing slash kept), with %,
  // \\, newlines, tabs, # and ? escaped; the URL parser escapes the rest.
  const pathToFileURL = (path: string) => {
    let absolute = resolve(path);
    if (path.endsWith('/') && !absolute.endsWith('/')) absolute += '/';
    const escaped = absolute
      .replace(/%/g, '%25')
      .replace(/\\/g, '%5C')
      .replace(/\n/g, '%0A')
      .replace(/\r/g, '%0D')
      .replace(/\t/g, '%09')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
    return new URL(`file://${escaped}`);
  };
  const parse = (text: string, query = false) => {
    try {
      const url = new URL(text);
      return {
        protocol: url.protocol,
        slashes: true,
        auth: url.username ? `${url.username}${url.password ? `:${url.password}` : ''}` : null,
        host: url.host,
        port: url.port || null,
        hostname: url.hostname,
        hash: url.hash || null,
        search: url.search || null,
        query: query ? Object.fromEntries(url.searchParams) : url.search.slice(1) || null,
        pathname: url.pathname,
        path: url.pathname + url.search,
        href: url.href,
      };
    } catch {
      const [pathname, search = ''] = text.split('?');
      return {
        protocol: null,
        slashes: null,
        host: null,
        hostname: null,
        pathname,
        search: search ? `?${search}` : null,
        query: query ? Object.fromEntries(new URLSearchParams(search)) : search || null,
        path: text,
        href: text,
      };
    }
  };
  return {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse,
    format: (url: URL | Record<string, string>) =>
      url instanceof URL
        ? url.href
        : `${url.protocol ?? ''}${url.slashes || url.protocol ? '//' : ''}${url.host ?? url.hostname ?? ''}${url.pathname ?? ''}${url.search ?? ''}${url.hash ?? ''}`,
    resolve: (from: string, to: string) =>
      new URL(to, new URL(from, 'resolve://')).href.replace(/^resolve:\/\//, ''),
    domainToASCII: (domain: string) => domain,
    domainToUnicode: (domain: string) => domain,
    urlToHttpOptions: (url: URL) => ({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
    }),
  };
}

function createVm() {
  const runIn = (code: string, context: Record<string, unknown> = {}) => {
    const names = Object.keys(context);
    // oxlint-disable-next-line no-new-func -- vm runs code.
    return new Function(...names, `return eval(${JSON.stringify(code)})`)(
      ...names.map((n) => context[n]),
    );
  };
  class Script {
    constructor(private code: string) {}
    // oxlint-disable-next-line no-eval -- vm runs code.
    runInThisContext = () => (0, eval)(this.code);
    runInNewContext = (context?: Record<string, unknown>) => runIn(this.code, context);
    runInContext = (context?: Record<string, unknown>) => runIn(this.code, context);
    createCachedData = () => new Uint8Array(0);
  }
  return {
    Script,
    // oxlint-disable-next-line no-eval -- vm runs code.
    runInThisContext: (code: string) => (0, eval)(code),
    runInNewContext: runIn,
    runInContext: runIn,
    createContext: (context: object = {}) => context,
    isContext: () => true,
    compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
  };
}

function createReadline(process: Record<string, unknown> & EventEmitter) {
  const createInterface = (options?: { input?: EventEmitter }) => {
    const rl = new EventEmitter() as EventEmitter & Record<string, unknown>;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      rl.emit('close');
    };
    Object.assign(rl, {
      close,
      pause: () => rl,
      resume: () => rl,
      setPrompt() {},
      prompt() {},
      write() {},
      getPrompt: () => '',
      line: '',
      terminal: false,
      // No input: every question answers empty.
      question(query: string, ...rest: unknown[]) {
        (process.stdout as { write(t: string): void }).write(query);
        const done = rest.pop();
        if (typeof done === 'function') queueMicrotask(() => done(''));
        else return Promise.resolve('');
      },
      [Symbol.asyncIterator]: async function* () {},
    });
    options?.input?.on?.('end', close);
    queueMicrotask(close);
    return rl;
  };
  return {
    createInterface,
    Interface: class Interface extends EventEmitter {},
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    emitKeypressEvents: () => {},
  };
}

function createCrypto() {
  const randomBytes = (size: number, callback?: (e: unknown, b: Buffer) => void) => {
    const bytes = Buffer.alloc(size);
    for (let at = 0; at < size; at += 65536)
      crypto.getRandomValues(bytes.subarray(at, at + 65536) as Uint8Array<ArrayBuffer>);
    if (callback) queueMicrotask(() => callback(null, bytes));
    return bytes;
  };
  return {
    webcrypto: crypto,
    subtle: crypto.subtle,
    getRandomValues: (array: ArrayBufferView) =>
      crypto.getRandomValues(array as Uint8Array<ArrayBuffer>),
    randomUUID: () => crypto.randomUUID(),
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync: (array: Uint8Array) => crypto.getRandomValues(array as Uint8Array<ArrayBuffer>),
    randomInt: (min: number, max?: number) => {
      if (max === undefined) [min, max] = [0, min];
      return min + Math.floor(Math.random() * (max - min));
    },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((x, i) => x === b[i]),
    ...hashes,
    ...missing('crypto', [
      'createCipheriv',
      'createDecipheriv',
      'pbkdf2Sync',
      'scryptSync',
      'createSign',
      'createVerify',
      'generateKeyPairSync',
    ]),
  };
}

// http's and https's Agent: its options kept, as nothing connects yet.
class Agent {
  constructor(public options: Record<string, unknown> = {}) {}
}

class AssertionError extends Error {
  code = 'ERR_ASSERTION';
  constructor(
    message: string,
    public actual?: unknown,
    public expected?: unknown,
    public operator?: string,
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

function createAssert() {
  const fail = (
    message: unknown,
    fallback: string,
    actual?: unknown,
    expected?: unknown,
    operator?: string,
  ): never => {
    if (message instanceof Error) throw message;
    throw new AssertionError((message as string) ?? fallback, actual, expected, operator);
  };
  const looseEqual = (a: unknown, b: unknown): boolean => {
    // oxlint-disable-next-line eqeqeq -- assert.equal is ==.
    if (a == b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) =>
        looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  };
  const matches = (error: unknown, expected: unknown): boolean => {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      if (
        (expected as { prototype?: unknown }).prototype !== undefined &&
        error instanceof (expected as new () => unknown)
      )
        return true;
      if (Error.isPrototypeOf(expected as object)) return false;
      return (expected as (e: unknown) => boolean)(error) === true;
    }
    if (expected instanceof RegExp) return expected.test(String(error));
    if (typeof expected === 'object' && expected)
      return Object.entries(expected).every(([k, v]) => {
        const actual = (error as Record<string, unknown>)[k];
        return v instanceof RegExp ? v.test(String(actual)) : isDeepStrictEqual(actual, v);
      });
    return false;
  };
  const ok = (value: unknown, message?: unknown) => {
    if (!value)
      fail(
        message,
        `The expression evaluated to a falsy value:\n\n  assert.ok(${inspect(value)})\n`,
        value,
        true,
        '==',
      );
  };
  const assert = Object.assign(ok, {
    ok,
    AssertionError,
    fail: (message?: unknown) => fail(message, 'Failed'),
    equal: (a: unknown, b: unknown, message?: unknown) => {
      // oxlint-disable-next-line eqeqeq -- assert.equal is ==.
      if (a != b) fail(message, `${inspect(a)} == ${inspect(b)}`, a, b, '==');
    },
    notEqual: (a: unknown, b: unknown, message?: unknown) => {
      // oxlint-disable-next-line eqeqeq -- assert.notEqual is !=.
      if (a == b) fail(message, `${inspect(a)} != ${inspect(b)}`, a, b, '!=');
    },
    strictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!Object.is(a, b))
        fail(
          message,
          `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`,
          a,
          b,
          'strictEqual',
        );
    },
    notStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (Object.is(a, b))
        fail(
          message,
          `Expected "actual" to be strictly unequal to: ${inspect(b)}`,
          a,
          b,
          'notStrictEqual',
        );
    },
    deepEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!looseEqual(a, b))
        fail(
          message,
          `Expected values to be loosely deep-equal:\n\n${inspect(a)}\n\nshould loosely deep-equal\n\n${inspect(b)}`,
          a,
          b,
          'deepEqual',
        );
    },
    deepStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!isDeepStrictEqual(a, b))
        fail(
          message,
          `Expected values to be strictly deep-equal:\n\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`,
          a,
          b,
          'deepStrictEqual',
        );
    },
    notDeepStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (isDeepStrictEqual(a, b))
        fail(
          message,
          'Expected "actual" not to be strictly deep-equal to "expected"',
          a,
          b,
          'notDeepStrictEqual',
        );
    },
    match: (text: string, pattern: RegExp, message?: unknown) => {
      if (!pattern.test(text))
        fail(
          message,
          `The input did not match the regular expression ${pattern}. Input:\n\n${inspect(text)}\n`,
          text,
          pattern,
          'match',
        );
    },
    doesNotMatch: (text: string, pattern: RegExp, message?: unknown) => {
      if (pattern.test(text))
        fail(
          message,
          `The input was expected to not match the regular expression ${pattern}.`,
          text,
          pattern,
          'doesNotMatch',
        );
    },
    throws: (fn: () => unknown, expected?: unknown, message?: unknown) => {
      try {
        fn();
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      fail(
        typeof expected === 'string' ? expected : message,
        'Missing expected exception.',
        undefined,
        expected,
        'throws',
      );
    },
    doesNotThrow: (fn: () => unknown) => {
      fn();
    },
    rejects: async (
      promise: Promise<unknown> | (() => Promise<unknown>),
      expected?: unknown,
      message?: unknown,
    ) => {
      try {
        await (typeof promise === 'function' ? promise() : promise);
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      fail(
        typeof expected === 'string' ? expected : message,
        'Missing expected rejection.',
        undefined,
        expected,
        'rejects',
      );
    },
    doesNotReject: async (promise: Promise<unknown> | (() => Promise<unknown>)) => {
      await (typeof promise === 'function' ? promise() : promise);
    },
    ifError: (value: unknown) => {
      if (value !== null && value !== undefined) throw value;
    },
    strict: null as unknown,
  });
  assert.strict = Object.assign((v: unknown, m?: unknown) => ok(v, m), assert, {
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual,
  });
  return assert;
}
