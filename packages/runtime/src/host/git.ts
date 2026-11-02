// The IDE's git (runtime/git.ts): git.wasm in a worker of its own over
// `files`, a command at a time, its output whole.
import { Site, type SiteRef } from '../packages/manifest';
import type { GitResult } from '../git';
import type { Files, FilesChannel } from './files';
import { linkFor, siteFetch } from '../lib/apexLink';
import { worker } from './worker';

const encoder = new TextEncoder();

export interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
}

export interface GitOutput {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

// git.wasm by its URL, compiled once for every Git of the page.
const compiled = new Map<string, Promise<WebAssembly.Module | null>>();
function gitModule(url: string): Promise<WebAssembly.Module | null> {
  let module = compiled.get(url);
  if (!module) {
    module = siteFetch(url)
      .then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return response.ok && bytes[0] === 0 && bytes[1] === 0x61
          ? WebAssembly.compile(bytes)
          : null;
      })
      .catch(() => null);
    compiled.set(url, module);
  }
  return module;
}

// How long the worker stays once it has nothing to run.
const IDLE = 1000;

export class Git {
  worker: Worker;
  files: Files;
  channel: FilesChannel;
  pending = new Map<number, (result: GitResult) => void>();
  next = 0;
  ready: Promise<boolean>;
  private base: string;
  private site: SiteRef;
  // The commands asked for and not yet answered, and the worker's end once
  // there are none (null: it runs, or is gone).
  private busy = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private gone = false;

  // base: where git.js is; site: the site manifest (git.wasm is its git program's).
  constructor({ base, site, files }: { base: string; site: SiteRef; files: Files }) {
    this.files = files;
    this.base = base;
    this.site = site;
    this.channel = files.connect();
    [this.worker, this.ready] = this.start();
  }

  // A worker for the commands. In WebKit, while this worker, having run
  // git.wasm, waits for more, another worker's next WebAssembly memory now
  // and then hangs for good: a node's git (Mix's dependency check) as
  // Phoenix starts, and with that worker every thread of its BEAM. Measured
  // with Playwright's WebKit 2370 on 2026-11-01, two test workers: 5 boots
  // of 90 hung with the worker kept; with it ended once idle, 2 of about
  // 900 boots (both in one run with six test workers). So the worker goes
  // once it has had nothing to run for IDLE ms, and the next command starts
  // another.
  private start(): [Worker, Promise<boolean>] {
    const started = worker('git.js', this.base);
    started.onmessage = ({ data }: MessageEvent<GitResult>) => {
      this.pending.get(data.id)?.(data);
      this.pending.delete(data.id);
    };
    const { channel, site } = this;
    // git.wasm (tools/git/build.py), or null when the site has none.
    const ready = (async () => {
      const module = new Site(site).programs().get('git');
      const git = module ? await gitModule(module.url.href) : null;
      if (!git) return false;
      // Its way to the apex, for git's proxy (lib/apexLink.ts).
      const link = linkFor();
      started.postMessage({ kind: 'start', files: channel, git, link }, link ? [link] : []);
      return true;
    })().catch(() => false);
    return [started, ready];
  }

  async run(
    args: string[],
    { cwd = '/work', env = {}, stdin }: GitOptions = {},
  ): Promise<GitOutput> {
    this.busy++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.gone) {
      this.gone = false;
      [this.worker, this.ready] = this.start();
    }
    try {
      if (!(await this.ready))
        return { code: 127, stdout: new Uint8Array(0), stderr: encoder.encode('git: not found\n') };
      const id = ++this.next;
      const bytes = typeof stdin === 'string' ? encoder.encode(stdin) : (stdin ?? null);
      return await new Promise((resolve) => {
        this.pending.set(id, ({ code, stdout, stderr }) => resolve({ code, stdout, stderr }));
        this.worker.postMessage({ kind: 'run', id, args, cwd, env, stdin: bytes });
      });
    } finally {
      if (--this.busy === 0)
        this.idle = setTimeout(() => {
          this.idle = null;
          if (this.busy) return;
          this.worker.terminate();
          this.gone = true;
        }, IDLE);
    }
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.worker.terminate();
    this.files.disconnect(this.channel);
    const failed = encoder.encode('git: stopped\n');
    for (const resolve of this.pending.values())
      resolve({ id: 0, code: 1, stdout: new Uint8Array(0), stderr: failed });
    this.pending.clear();
  }
}
