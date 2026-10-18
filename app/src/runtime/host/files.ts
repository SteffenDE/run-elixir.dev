// The page's side of the shared files (files.ts, a worker of its own).
import { worker } from './worker';

const CHANNEL = 1 << 20;

// A path below a directory, and whether it is one (Files.list).
export interface Entry {
  path: string;
  dir: boolean;
}

// A search of file contents (Files.search): a text, or a regular
// expression; of any case, or this one.
export interface SearchQuery {
  text: string;
  regex: boolean;
  matchCase: boolean;
}

// A match: where it is (one-based), and its line as it shows, from a
// little before it (`cut`: not from its start), the match `at` in it.
export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  at: number;
  length: number;
  cut: boolean;
}

// The hits, in the order of the files; `truncated` when there were more
// than were kept; `error` when the expression is not one.
export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  error?: string;
}

export interface Stat {
  type: 'file' | 'dir';
  size: number;
  mtime: number;
  ino: number;
}

// The shared filesystem's operations (files.js through Files).
export interface FileSystem {
  list(path: string, skip?: string[]): Promise<Entry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, to: string): Promise<void>;
  stat(path: string): Promise<'file' | 'dir' | null>;
  lstat(path: string): Promise<Stat>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

// A node's way to the shared files (wasi/shared.ts sharedClient).
export interface FilesChannel {
  doorbell: SharedArrayBuffer;
  channel: SharedArrayBuffer;
}

// What files.js answers a request with: its fields, by request.
// oxlint-disable-next-line typescript/no-explicit-any -- each op's own.
type Reply = Record<string, any>;

// The shared filesystem (files.js): /work and /tmp, which every node and
// the page see. onchange(paths): what changed in it.
export class Files implements FileSystem {
  doorbell: SharedArrayBuffer;
  requests: Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>;
  next: number;
  worker: Worker;
  ready: Promise<void>;

  // base: where files.js is; runtime: the site's files (build.ts
  // RUNTIME), by default base. boots, template, store: what files.js
  // starts with (its 'start').
  // onwarning(message): a change that was not kept.
  constructor({
    base = './',
    runtime = null as string | null,
    boots = ['boot'],
    template = [] as string[],
    store = null as string | null,
    onchange = (_paths: string[]) => {},
    onwarning = (_message: string) => {},
  } = {}) {
    this.doorbell = new SharedArrayBuffer(4);
    this.requests = new Map();
    this.next = 0;
    this.worker = worker('files.js', base);
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.kind === 'ready') resolve();
        else if (data.kind === 'failed') reject(new Error(data.message));
        else if (data.kind === 'changed') onchange(data.paths);
        else if (data.kind === 'warning') onwarning(data.message);
        else if (data.kind === 'reply') {
          const request = this.requests.get(data.id);
          this.requests.delete(data.id);
          if (data.error)
            request?.reject(Object.assign(new Error(data.error), { code: data.code }));
          else request?.resolve(data);
        }
      };
    });
    this.worker.postMessage({
      kind: 'start',
      runtime: new URL(runtime ?? base, location.href).href,
      doorbell: this.doorbell,
      boots,
      template,
      store,
    });
  }

  // A node's channel (wasi/shared.ts sharedClient).
  connect(): FilesChannel {
    const channel = new SharedArrayBuffer(8 + CHANNEL);
    this.worker.postMessage({ kind: 'connect', channel });
    return { doorbell: this.doorbell, channel };
  }
  disconnect({ channel }: FilesChannel): void {
    this.worker.postMessage({ kind: 'disconnect', channel });
  }

  ask(request: { op: string } & Record<string, unknown>): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ kind: 'request', id, ...request });
    });
  }
  list(path: string, skip: string[] = []): Promise<Entry[]> {
    return this.ask({ op: 'list', path, skip }).then((r) => r.entries);
  }
  // 'file', 'dir', or null when there is nothing at `path`.
  stat(path: string): Promise<'file' | 'dir' | null> {
    return this.ask({ op: 'stat', path }).then((r) => r.type);
  }
  // In POSIX's shape, failing with its codes (ENOENT, ENOTDIR, ENOTEMPTY):
  // { type, size, mtime (ms), ino }; the names in a directory; removing a
  // file, an empty directory.
  lstat(path: string): Promise<Stat> {
    return this.ask({ op: 'lstat', path }) as Promise<Stat>;
  }
  readdir(path: string): Promise<string[]> {
    return this.ask({ op: 'readdir', path }).then((r) => r.names);
  }
  unlink(path: string): Promise<void> {
    return this.ask({ op: 'unlink', path }).then(() => {});
  }
  rmdir(path: string): Promise<void> {
    return this.ask({ op: 'rmdir', path }).then(() => {});
  }
  read(path: string): Promise<Uint8Array> {
    return this.ask({ op: 'read', path }).then((r) => r.data);
  }
  write(path: string, data: string | Uint8Array): Promise<void> {
    return this.ask({
      op: 'write',
      path,
      data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    }).then(() => {});
  }
  mkdir(path: string): Promise<void> {
    return this.ask({ op: 'mkdir', path }).then(() => {});
  }
  remove(path: string): Promise<void> {
    return this.ask({ op: 'remove', path }).then(() => {});
  }
  rename(path: string, to: string): Promise<void> {
    return this.ask({ op: 'rename', path, to }).then(() => {});
  }
  // What the project changed below /work over its template, but in
  // directories named in `skip`: { changed: [{ path, data }], removed }.
  changes(
    skip: string[] = [],
  ): Promise<{ changed: { path: string; data: Uint8Array }[]; removed: string[] }> {
    return this.ask({ op: 'changes', skip }).then(({ changed, removed }) => ({ changed, removed }));
  }
  // The matches of `query` in the text files below `path`, but in
  // directories named in `skip`, at most `limit`.
  search(
    path: string,
    query: SearchQuery,
    skip: string[] = [],
    limit = 1000,
  ): Promise<SearchResult> {
    return this.ask({ op: 'search', path, query, skip, limit }).then(
      ({ hits, truncated, error }) => ({ hits, truncated, error }),
    );
  }
  // Keep everything changed so far (a store's).
  flush(): Promise<void> {
    return this.ask({ op: 'flush' }).then(() => {});
  }
}
