// git's remote helper for https:// and http:// (git remote-https REMOTE
// URL, which git.wasm starts for a remote's transport): protocol v2's
// `stateless-connect`, which only carries pkt-lines between git and smart
// HTTP. Its capability advertisement comes from a GET of info/refs; each
// request git writes (pkt-lines to a flush) is a POST to git-upload-pack,
// whose answer goes back as it comes, then a response-end packet. Fetching
// only: there is no `push` (the site's proxy passes no git-receive-pack:
// docs/git.md#push).
import { writeAll, type Program } from './processes';
import type { Descriptor } from './wasi/descriptors';

// Where a repository's smart HTTP is reached from here (the site's proxy,
// as the page's git has it), or null when it is not.
export type Locate = (url: URL) => string | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The site's proxy at /git/HOST/OWNER/REPO (serve.py, Caddy: docs/deploy.md).
const PROXIED = ['github.com', 'gitlab.com', 'codeberg.org'];

// What git starts by a dashed name that is git.wasm itself: a transport's
// other end (over file://, through sh).
export const GIT_DASHED = new Set(['git-upload-pack', 'git-receive-pack', 'git-upload-archive']);

// git's configuration for the playground's remotes (GIT_CONFIG_COUNT and
// its pairs): their SSH addresses (git@HOST:OWNER/REPO, ssh://) as HTTPS,
// which the helper fetches; there is no ssh.
export const GIT_CONFIG: Record<string, string> = (() => {
  const pairs = PROXIED.flatMap((host) => [
    [`url.https://${host}/.insteadOf`, `git@${host}:`],
    [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`],
  ]);
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(pairs.length)],
    ...pairs.flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
    ]),
  ]);
})();
export const throughProxy =
  (origin: string): Locate =>
  (url) =>
    PROXIED.includes(url.hostname) && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)
      ? `${origin}/git/${url.hostname}${url.pathname.replace(/\/$/, '')}`
      : null;

// What a pipe's reader has: bytes as they come, a line, a packet.
class Reader {
  declare entry: Descriptor;
  declare buffer: Uint8Array;

  constructor(entry: Descriptor) {
    this.entry = entry;
    this.buffer = new Uint8Array(0);
  }

  // At least `count` bytes buffered; false at the end before them.
  async fill(count: number): Promise<boolean> {
    const pipe = this.entry.pipe!;
    while (this.buffer.length < count) {
      const bytes = pipe.read(65536);
      if (!bytes) await pipe.changed();
      else if (!bytes.length) return false;
      else {
        const joined = new Uint8Array(this.buffer.length + bytes.length);
        joined.set(this.buffer);
        joined.set(bytes, this.buffer.length);
        this.buffer = joined;
      }
    }
    return true;
  }

  take(count: number): Uint8Array {
    const bytes = this.buffer.slice(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  // A line without its newline; null at the end.
  async line(): Promise<string | null> {
    for (let size = 1; ; size = this.buffer.length + 1) {
      const at = this.buffer.indexOf(10);
      if (at >= 0) return decoder.decode(this.take(at + 1)).slice(0, -1);
      if (!(await this.fill(size))) return null;
    }
  }

  // A request: pkt-lines to a flush packet, as written; null at the end.
  async request(): Promise<Uint8Array<ArrayBuffer> | null> {
    const parts: Uint8Array[] = [];
    for (;;) {
      if (!(await this.fill(4))) return null;
      const length = parseInt(decoder.decode(this.buffer.subarray(0, 4)), 16);
      const size = length < 4 ? 4 : length;
      if (!(await this.fill(size))) return null;
      parts.push(this.take(size));
      if (length === 0) break;
    }
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

// The advertisement without smart HTTP's "# service=…" packet and the
// flush after it, as remote-curl takes it; null unless it is protocol v2.
function advertisement(bytes: Uint8Array): Uint8Array | null {
  const packet = (at: number) => {
    const length = parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
    return { length, text: decoder.decode(bytes.subarray(at + 4, at + Math.max(length, 4))) };
  };
  let at = 0;
  const first = packet(0);
  if (first.text.startsWith('# service=')) {
    at = first.length;
    if (packet(at).length !== 0) return null;
    at += 4;
  }
  return packet(at).text === 'version 2\n' ? bytes.subarray(at) : null;
}

export function remoteHelper(locate: Locate, fetcher: typeof fetch = fetch): Program {
  return async (child, { args, stdio: [input, output, errors] }) => {
    const write = (bytes: Uint8Array | string) =>
      writeAll(output, typeof bytes === 'string' ? encoder.encode(bytes) : bytes, child, null);
    const fail = async (message: string) => {
      await writeAll(errors, encoder.encode(`fatal: ${message}\n`), child, null);
      return 128;
    };
    // remote-https REMOTE [URL]: the remote's name, or its URL alone.
    const url = args[2] ?? args[1];
    let base: string | null = null;
    try {
      base = locate(new URL(url));
    } catch {
      // Not a URL: base stays null.
    }
    if (!base)
      return fail(
        `unable to access '${url}': the playground fetches only from ${PROXIED.join(', ')} (public repositories, through its proxy)`,
      );
    const reader = new Reader(input);
    for (;;) {
      const line = await reader.line();
      if (line === null) return 0;
      if (line === '') continue;
      if (line === 'capabilities') {
        if (!(await write('stateless-connect\n\n'))) return 141;
        continue;
      }
      const [command, service] = line.split(' ');
      if (command !== 'stateless-connect')
        return fail(`remote-https: ${command}: only fetching (no push) works in the playground`);
      if (service !== 'git-upload-pack') {
        await write('fallback\n');
        return fail(`remote-https: ${service}: only fetching (no push) works in the playground`);
      }
      const refs = await fetcher(`${base}/info/refs?service=${service}`, {
        headers: { 'Git-Protocol': 'version=2' },
      }).catch((error: Error) => error);
      if (refs instanceof Error) return fail(`unable to access '${url}': ${refs.message}`);
      if (!refs.ok) return fail(`unable to access '${url}': the server answered ${refs.status}`);
      const advertised = advertisement(new Uint8Array(await refs.arrayBuffer()));
      if (!advertised) {
        await write('fallback\n');
        return fail(`unable to access '${url}': the server does not speak protocol v2`);
      }
      if (!(await write('\n')) || !(await write(advertised))) return 141;
      // Its requests, each to a flush packet, until git closes our input.
      for (;;) {
        const request = await reader.request();
        if (!request) return 0;
        const answer = await fetcher(`${base}/${service}`, {
          method: 'POST',
          headers: {
            'Content-Type': `application/x-${service}-request`,
            Accept: `application/x-${service}-result`,
            'Git-Protocol': 'version=2',
          },
          body: request,
        }).catch((error: Error) => error);
        if (answer instanceof Error) return fail(`unable to access '${url}': ${answer.message}`);
        if (!answer.ok || !answer.body)
          return fail(`unable to access '${url}': the server answered ${answer.status}`);
        const body = answer.body.getReader();
        for (;;) {
          const { done, value } = await body.read();
          if (done) break;
          if (!(await write(value))) {
            void body.cancel();
            return 141;
          }
        }
        // The response's end (stateless-connect's).
        if (!(await write('0002'))) return 141;
      }
    }
  };
}
