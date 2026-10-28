// The IDE's git (runtime/git.ts): git.wasm in a worker of its own over
// `files`, a command at a time, its output whole.
import { Site, type SiteRef } from '../packages/manifest';
import type { GitResult } from '../git';
import type { Files, FilesChannel } from './files';
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

export class Git {
  worker: Worker;
  files: Files;
  channel: FilesChannel;
  pending = new Map<number, (result: GitResult) => void>();
  next = 0;
  ready: Promise<boolean>;

  // base: where git.js is; site: the site manifest (git.wasm is its git program's).
  constructor({ base, site, files }: { base: string; site: SiteRef; files: Files }) {
    this.files = files;
    this.channel = files.connect();
    this.worker = worker('git.js', base);
    this.worker.onmessage = ({ data }: MessageEvent<GitResult>) => {
      this.pending.get(data.id)?.(data);
      this.pending.delete(data.id);
    };
    const { channel, worker: started } = this;
    // git.wasm (tools/git/build.py), or null when the site has none.
    this.ready = (async () => {
      const module = new Site(site).programs().get('git');
      if (!module) return false;
      const response = await fetch(module.url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || bytes[0] !== 0 || bytes[1] !== 0x61) return false;
      started.postMessage({ kind: 'start', files: channel, git: await WebAssembly.compile(bytes) });
      return true;
    })().catch(() => false);
  }

  async run(
    args: string[],
    { cwd = '/work', env = {}, stdin }: GitOptions = {},
  ): Promise<GitOutput> {
    if (!(await this.ready))
      return { code: 127, stdout: new Uint8Array(0), stderr: encoder.encode('git: not found\n') };
    const id = ++this.next;
    const bytes = typeof stdin === 'string' ? encoder.encode(stdin) : (stdin ?? null);
    return new Promise((resolve) => {
      this.pending.set(id, ({ code, stdout, stderr }) => resolve({ code, stdout, stderr }));
      this.worker.postMessage({ kind: 'run', id, args, cwd, env, stdin: bytes });
    });
  }

  stop(): void {
    this.worker.terminate();
    this.files.disconnect(this.channel);
    const failed = encoder.encode('git: stopped\n');
    for (const resolve of this.pending.values())
      resolve({ id: 0, code: 1, stdout: new Uint8Array(0), stderr: failed });
    this.pending.clear();
  }
}
