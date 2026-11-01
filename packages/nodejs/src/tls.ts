// node:tls's client: rustls built to WebAssembly (tls/, the site's
// tls.wasm), in the process's worker, over a socket's bytes: the TLS a
// node does itself (docs/nodejs.md). The module loads on the first
// connection, one instance per process, a handle per connection.
//
// An Engine is one connection's TLS without I/O: feed it what the socket
// read, write what the program writes, send what take() gives. TLSSocket
// is Node's, over a net.Socket it opens or one it is given (STARTTLS, as
// pg's ssl); net.ts's HTTPS by the gateway takes an Engine itself when the
// gateway says "tcp" (the tailnet's TCP to the host).
import { Buffer } from './buffer';
import * as streams from 'readable-stream';
import type { Net } from './net';

const { Duplex } = streams as typeof import('node:stream');

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  tls_alloc(len: number): number;
  tls_free(ptr: number, len: number): void;
  tls_out_ptr(): number;
  tls_out_len(): number;
  tls_client(...args: number[]): number;
  tls_feed(handle: number, ptr: number, len: number): number;
  tls_write(handle: number, ptr: number, len: number): number;
  tls_take(handle: number): number;
  tls_read(handle: number): number;
  tls_handshaking(handle: number): number;
  tls_alpn(handle: number): number;
  tls_version(handle: number): number;
  tls_cipher(handle: number): number;
  tls_peer(handle: number): number;
  tls_refused(handle: number): number;
  tls_close(handle: number): void;
  tls_forget(handle: number): void;
}

type Pem = string | Uint8Array | (string | Uint8Array)[];

export interface TlsOptions {
  servername?: string;
  ALPNProtocols?: (string | Uint8Array)[];
  rejectUnauthorized?: boolean;
  ca?: Pem;
  cert?: Pem;
  key?: Pem;
  checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
}

// WASI as far as rustls asks: randomness, the clock, no environment, and
// output that goes nowhere.
function wasi(memory: () => WebAssembly.Memory) {
  const view = () => new DataView(memory().buffer);
  return {
    random_get(ptr: number, len: number) {
      // getRandomValues takes at most 64 KiB at a time.
      for (let at = 0; at < len; at += 65536)
        crypto.getRandomValues(
          new Uint8Array(memory().buffer, ptr + at, Math.min(65536, len - at)),
        );
      return 0;
    },
    clock_time_get(_id: number, _precision: bigint, out: number) {
      view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
    fd_write(_fd: number, iovs: number, n: number, written: number) {
      let total = 0;
      for (let i = 0; i < n; i++) total += view().getUint32(iovs + 8 * i + 4, true);
      view().setUint32(written, total, true);
      return 0;
    },
    proc_exit(code: number) {
      throw new Error(`tls.wasm exited (${code})`);
    },
  };
}

let loading: Promise<Exports> | null = null;
// The browser's fetch, as the module loads: the process's global one is
// Node's (fetch.ts), which reaches the project's ports, not the site.
const siteFetch = globalThis.fetch.bind(globalThis);
// And its XMLHttpRequest (a process with Bun's globals goes without one,
// claude/bun.ts), for the roots, which Node's tls has at once.
const SiteRequest = globalThis.XMLHttpRequest;

// Mozilla's roots as PEM certificates (the site's roots.pem, the nodes'
// CA bundle), read once, synchronously; none if the site has none.
let roots: readonly string[] | null = null;
function rootCertificates(files: TlsFiles | null): readonly string[] {
  if (roots) return roots;
  let text = '';
  try {
    const request = new SiteRequest();
    if (!files) throw new Error('no tls package');
    request.open('GET', files.roots, false);
    request.send();
    if (request.status === 200) text = request.responseText;
  } catch {
    // No roots, as before.
  }
  roots = Object.freeze(
    text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [],
  );
  return roots;
}

// The tls package's files (site.json: Site.tls()): tls.wasm and the roots.
export interface TlsFiles {
  module: string;
  roots: string;
}

// tls.wasm from the tls package, once per process.
export function loadTls(files: TlsFiles | null): Promise<Exports> {
  loading ??= (async () => {
    if (!files) throw new Error('tls.wasm: this site has no tls package');
    const response = await siteFetch(files.module);
    if (!response.ok) throw new Error(`tls.wasm: ${response.status}`);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    let exports: Exports;
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi(() => exports.memory),
    });
    exports = instance.exports as unknown as Exports;
    // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a library's start.
    exports._initialize?.();
    return exports;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
const pem = (data: Pem | undefined) =>
  data === undefined
    ? new Uint8Array(0)
    : bytesOf(
        (Array.isArray(data) ? data : [data]).map((p) => decoder.decode(bytesOf(p))).join('\n'),
      );

// Node's codes for what rustls says of a certificate (OpenSSL's names).
function certificateCode(message: string): [string, string] {
  // rustls's Display (certificate expired: …) or Debug (Expired) names.
  if (/expired/i.test(message)) return ['CERT_HAS_EXPIRED', 'certificate has expired'];
  if (/not ?valid ?yet/i.test(message))
    return ['CERT_NOT_YET_VALID', 'certificate is not yet valid'];
  if (/not ?valid ?for ?name/i.test(message))
    return ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"];
  if (/unknown ?issuer/i.test(message))
    return ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'];
  if (/revoked/i.test(message)) return ['CERT_REVOKED', 'certificate revoked'];
  return ['ERR_TLS_CERT_INVALID', message];
}

export class TlsError extends Error {
  code: string;
  constructor(message: string) {
    const [code, text] = /certificate/i.test(message)
      ? certificateCode(message)
      : [
          'ERR_SSL_' +
            message
              .replace(/[^A-Za-z0-9]+/g, '_')
              .toUpperCase()
              .slice(0, 60),
          message,
        ];
    super(text);
    this.code = code;
  }
}

// One connection's TLS, without I/O.
export class Engine {
  constructor(
    private x: Exports,
    private handle: number,
  ) {}

  static async open(files: TlsFiles | null, host: string, options: TlsOptions): Promise<Engine> {
    const x = await loadTls(files);
    const alpn = (options.ALPNProtocols ?? []).map(bytesOf);
    const wire = new Uint8Array(alpn.reduce((n, p) => n + p.length + 1, 0));
    let at = 0;
    for (const protocol of alpn) {
      wire[at] = protocol.length;
      wire.set(protocol, at + 1);
      at += protocol.length + 1;
    }
    const args = [
      encoder.encode(options.servername || host),
      wire,
      pem(options.ca),
      pem(options.cert),
      pem(options.key),
    ].map((bytes) => Engine.put(x, bytes));
    const reject = options.rejectUnauthorized !== false ? 1 : 0;
    const [name, protocols, ca, cert, key] = args;
    const handle = x.tls_client(...name, ...protocols, reject, ...ca, ...cert, ...key);
    for (const [ptr, len] of args) x.tls_free(ptr, len);
    if (handle < 0) throw new TlsError(Engine.text(x));
    return new Engine(x, handle);
  }

  private static put(x: Exports, bytes: Uint8Array): [number, number] {
    const ptr = x.tls_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  }
  private static out(x: Exports): Uint8Array {
    return new Uint8Array(x.memory.buffer, x.tls_out_ptr(), x.tls_out_len()).slice();
  }
  private static text(x: Exports): string {
    return decoder.decode(Engine.out(x));
  }

  private call(f: (ptr: number, len: number) => number, bytes: Uint8Array): number {
    const [ptr, len] = Engine.put(this.x, bytes);
    try {
      return f(ptr, len);
    } finally {
      this.x.tls_free(ptr, len);
    }
  }

  // What the socket read; the program's bytes (null: the server closed).
  // Throws a TlsError (after which take() has the alert to send).
  feed(bytes: Uint8Array): Uint8Array | null {
    if (this.call((p, l) => this.x.tls_feed(this.handle, p, l), bytes) < 0)
      throw new TlsError(Engine.text(this.x));
    const n = this.x.tls_read(this.handle);
    return n === -2 ? null : n > 0 ? Engine.out(this.x) : new Uint8Array(0);
  }
  write(bytes: Uint8Array): void {
    if (this.call((p, l) => this.x.tls_write(this.handle, p, l), bytes) < 0)
      throw new TlsError(Engine.text(this.x));
  }
  // What to send now (may be empty).
  take(): Uint8Array {
    return this.x.tls_take(this.handle) > 0 ? Engine.out(this.x) : new Uint8Array(0);
  }
  close(): void {
    this.x.tls_close(this.handle);
  }
  forget(): void {
    this.x.tls_forget(this.handle);
  }
  get handshaking(): boolean {
    return this.x.tls_handshaking(this.handle) === 1;
  }
  get alpn(): string | false {
    return this.x.tls_alpn(this.handle) > 0 ? Engine.text(this.x) : false;
  }
  get protocol(): string | null {
    const version = this.x.tls_version(this.handle);
    return version === 0x0304 ? 'TLSv1.3' : version === 0x0303 ? 'TLSv1.2' : null;
  }
  get cipher(): string {
    this.x.tls_cipher(this.handle);
    return Engine.text(this.x);
  }
  // Why the roots did not vouch for the server's certificate (rustls's
  // words), or null.
  get refused(): string | null {
    return this.x.tls_refused(this.handle) > 0 ? Engine.text(this.x) : null;
  }
  // The server's chain, leaf first, DER.
  get chain(): Uint8Array[] {
    this.x.tls_peer(this.handle);
    const all = Engine.out(this.x);
    const view = new DataView(all.buffer);
    const out: Uint8Array[] = [];
    for (let at = 0; at + 4 <= all.length;) {
      const len = view.getUint32(at);
      out.push(all.slice(at + 4, at + 4 + len));
      at += 4 + len;
    }
    return out;
  }
}

type Socket = ReturnType<Net['module']['connect']>;

// A stream whose other side closed: its end once what it holds is read
// (a paused one's when it is resumed, as Node's), then its destroy.
export function closeAfterEnd(stream: InstanceType<typeof Duplex>): void {
  if (stream.destroyed) return;
  if (stream.readableEnded) return void stream.destroy();
  stream.once('end', () => stream.destroy());
  stream.push(null);
  // As Node's sockets at their end: with nothing buffered, 'end' now.
  stream.read(0);
}
type Duplex = InstanceType<typeof Duplex>;

// DER's values in [start, end): each one's tag and where its content is.
function der(bytes: Uint8Array, start = 0, end = bytes.length) {
  const out: { tag: number; start: number; end: number }[] = [];
  for (let at = start; at + 2 <= end;) {
    const tag = bytes[at];
    let len = bytes[at + 1];
    at += 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + bytes[at++];
    }
    out.push({ tag, start: at, end: at + len });
    at += len;
  }
  return out;
}

// A Name's attributes Node names (several of one: an array).
const ATTRIBUTES: Record<number, string> = {
  3: 'CN',
  6: 'C',
  7: 'L',
  8: 'ST',
  10: 'O',
  11: 'OU',
};
function names(bytes: Uint8Array, name: { start: number; end: number }) {
  const out: Record<string, string | string[]> = {};
  for (const set of der(bytes, name.start, name.end))
    for (const pair of der(bytes, set.start, set.end)) {
      const [oid, value] = der(bytes, pair.start, pair.end);
      // 2.5.4.x
      if (!oid || !value || oid.end - oid.start !== 3) continue;
      if (bytes[oid.start] !== 0x55 || bytes[oid.start + 1] !== 0x04) continue;
      const key = ATTRIBUTES[bytes[oid.start + 2]];
      if (!key) continue;
      const text = decoder.decode(bytes.subarray(value.start, value.end));
      const had = out[key];
      out[key] = had === undefined ? text : [...(Array.isArray(had) ? had : [had]), text];
    }
  return out;
}

// An IPv6 address as one string, whichever way it is written.
function canonicalIP(ip: string) {
  try {
    return ip.includes(':') ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
  } catch {
    return ip;
  }
}

// The subjectAltName extension as Node words it.
function altNames(bytes: Uint8Array, extensions: { start: number; end: number }) {
  const [list] = der(bytes, extensions.start, extensions.end);
  for (const extension of list ? der(bytes, list.start, list.end) : []) {
    const [oid, ...rest] = der(bytes, extension.start, extension.end);
    // 2.5.29.17
    const id = bytes.subarray(oid.start, oid.end);
    if (id.length !== 3 || id[0] !== 0x55 || id[1] !== 0x1d || id[2] !== 0x11) continue;
    const value = rest.at(-1)!;
    const [sequence] = der(bytes, value.start, value.end);
    const out: string[] = [];
    for (const name of der(bytes, sequence.start, sequence.end)) {
      const content = bytes.subarray(name.start, name.end);
      const text = () => decoder.decode(content);
      if (name.tag === 0x82) out.push(`DNS:${text()}`);
      else if (name.tag === 0x81) out.push(`email:${text()}`);
      else if (name.tag === 0x86) out.push(`URI:${text()}`);
      else if (name.tag === 0x87 && content.length === 4)
        out.push(`IP Address:${content.join('.')}`);
      else if (name.tag === 0x87 && content.length === 16) {
        const groups = [];
        for (let i = 0; i < 16; i += 2)
          groups.push(((content[i] << 8) | content[i + 1]).toString(16));
        out.push(`IP Address:${groups.join(':')}`);
      }
    }
    return out.join(', ');
  }
  return undefined;
}

// What Node's getPeerCertificate answers of a DER certificate: the raw
// one, its subject, issuer and altnames, and its issuer's (detailed).
export function certificate(chain: Uint8Array[], at = 0, detailed = false): PeerCertificate {
  const raw = chain[at];
  if (!raw) return {};
  const out: PeerCertificate = { raw: Buffer.from(raw), subject: {}, issuer: {} };
  try {
    const [cert] = der(raw);
    const [tbs] = der(raw, cert.start, cert.end);
    const fields = der(raw, tbs.start, tbs.end);
    // Its version ([0]) is there but for version 1.
    const first = fields[0].tag === 0xa0 ? 1 : 0;
    // Its serial number and signature's algorithm, issuer, validity, subject, key, ...
    out.issuer = names(raw, fields[first + 2]);
    out.subject = names(raw, fields[first + 4]);
    const extensions = fields.slice(first + 6).find((field) => field.tag === 0xa3);
    const san = extensions && altNames(raw, extensions);
    if (san !== undefined) out.subjectaltname = san;
  } catch {
    // A certificate past parsing: only its raw bytes.
  }
  if (detailed && chain[at + 1]) out.issuerCertificate = certificate(chain, at + 1, true);
  return out;
}

export interface PeerCertificate {
  raw?: Uint8Array;
  subject?: Record<string, string | string[]>;
  issuer?: Record<string, string | string[]>;
  subjectaltname?: string;
  issuerCertificate?: PeerCertificate;
}

// Whether the host's labels are those of a name the certificate gives
// (its first label perhaps a wildcard), as Node's check.
function nameMatches(host: string[], name: string) {
  const parts = name.replace(/[.]$/, '').toLowerCase().split('.');
  if (!name || parts.length !== host.length || parts.includes('')) return false;
  if (parts.some((part) => /[^!-\u007F]/u.test(part))) return false;
  for (let i = host.length - 1; i > 0; i--) if (host[i] !== parts[i]) return false;
  const wildcard = parts[0].split('*');
  if (wildcard.length === 1) return host[0] === parts[0];
  if (wildcard.length > 2 || parts.length <= 2) return false;
  const [prefix, suffix] = wildcard;
  return (
    prefix.length + suffix.length <= host[0].length &&
    host[0].startsWith(prefix) &&
    host[0].endsWith(suffix)
  );
}

// What a caller's checkServerIdentity says of a handshake done, once rustls
// has authorized the certificate: its error, or undefined.
export function identityRefusal(
  engine: { refused: string | null; chain: Uint8Array[] },
  host: string,
  options: TlsOptions,
): Error | undefined {
  if (engine.refused !== null || !options.checkServerIdentity) return undefined;
  return options.checkServerIdentity(
    options.servername || host,
    certificate(engine.chain, 0, true),
  );
}

// Node's tls.checkServerIdentity: undefined when the certificate names the
// host (its altnames, else its CN), else why not.
export function checkServerIdentity(hostname: string, cert: PeerCertificate) {
  const altnames = cert.subjectaltname;
  const dns: string[] = [];
  const ips: string[] = [];
  for (const name of altnames ? altnames.split(', ') : []) {
    if (name.startsWith('DNS:')) dns.push(name.slice(4));
    else if (name.startsWith('IP Address:')) ips.push(canonicalIP(name.slice(11)));
  }
  const host = String(hostname).replace(/[.]$/, '');
  const cn = cert.subject?.CN;
  let reason: string;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (ips.includes(canonicalIP(host))) return undefined;
    reason = `IP: ${host} is not in the cert's list: ${ips.join(', ')}`;
  } else if (dns.length || cn) {
    const parts = host.toLowerCase().split('.');
    const matches = (name: string) => nameMatches(parts, name);
    if (dns.length) {
      if (dns.some(matches)) return undefined;
      reason = `Host: ${host}. is not in the cert's altnames: ${altnames}`;
    } else {
      if (Array.isArray(cn) ? cn.some(matches) : matches(cn!)) return undefined;
      reason = `Host: ${host}. is not cert's CN: ${cn}`;
    }
  } else reason = 'Cert does not contain a DNS name';
  return Object.assign(new Error(`Hostname/IP does not match certificate's altnames: ${reason}`), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    reason,
    host,
    cert,
  });
}

export function createTls(net: Net, files: TlsFiles | null, env: Record<string, string>) {
  // tls.connect's TLSSocket: TLS over `raw`, plaintext for the program.
  class TLSSocket extends Duplex {
    declare raw: Duplex & Partial<Socket>;
    declare engine: Engine | null;
    declare authorized: boolean;
    declare authorizationError: string | null;
    declare encrypted: true;
    declare alpnProtocol: string | false;
    declare servername: string;
    declare connecting: boolean;
    declare pendingWrites: [Uint8Array, (error?: Error | null) => void][];
    // Plain HTTP to the gateway's fetch() (no tailnet for port 443): the
    // browser does the TLS, and checks the certificate.
    declare plain: boolean;
    // The program's own check of the certificate's names, once rustls's
    // passed it, and what it refuses.
    declare checkIdentity: (() => Error | undefined) | null;
    declare rejectUnauthorized: boolean;

    // Node's (socket, options): a client over the socket, to options.host.
    constructor(raw: Duplex, options: TlsOptions & { host?: string } = {}) {
      super({ allowHalfOpen: false, decodeStrings: true });
      const host = options.host ?? 'localhost';
      this.raw = raw as Duplex & Partial<Socket>;
      this.engine = null;
      this.authorized = false;
      this.authorizationError = null;
      this.encrypted = true;
      this.alpnProtocol = false;
      this.servername = options.servername ?? host;
      this.connecting = true;
      this.pendingWrites = [];
      this.plain = false;
      raw.once('gateway', (line: string) => (this.plain = line === 'fetch'));
      const reject = options.rejectUnauthorized ?? env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
      this.rejectUnauthorized = reject;
      const check = options.checkServerIdentity;
      this.checkIdentity = check
        ? () => check(options.servername || host, this.getPeerCertificate(true))
        : null;
      // What came before the engine waits for it.
      const early: Uint8Array[] = [];
      const ready = () => {
        if (this.plain) {
          this.authorized = true;
          this.alpnProtocol = 'http/1.1';
          this.secured();
          for (const chunk of early.splice(0)) this.received(chunk);
          return;
        }
        Engine.open(files, host, { ...options, rejectUnauthorized: reject }).then(
          (engine) => {
            if (this.destroyed) return engine.forget();
            this.engine = engine;
            this.flush();
            for (const chunk of early.splice(0)) this.received(chunk);
          },
          (error: Error) => this.destroy(error),
        );
      };
      if ((raw as Partial<Socket>).connecting || (raw as Partial<Socket>).pending)
        raw.once('connect', ready);
      else ready();
      raw.on('data', (chunk: Uint8Array) => {
        if (!this.engine && !(this.plain && !this.connecting)) return void early.push(chunk);
        this.received(chunk);
      });
      // The connection gone before the handshake was done: Node's error.
      const lost = () => {
        if (!this.connecting) return false;
        const message =
          'Client network socket disconnected before secure TLS connection was established';
        this.destroy(Object.assign(new Error(message), { code: 'ECONNRESET', host }));
        return true;
      };
      raw.on('end', () => lost() || this.push(null));
      // The connection closed: what it gave is read first, then the end,
      // then the close (destroying at once would drop what is buffered).
      raw.on('close', () => lost() || closeAfterEnd(this));
      raw.on('error', (error: Error) => this.destroy(error));
    }

    // Ciphertext to the socket.
    flush() {
      const out = this.engine?.take();
      if (out?.length) this.raw.write(out);
    }

    received(chunk: Uint8Array) {
      if (this.plain) return void this.push(Buffer.from(chunk));
      const engine = this.engine!;
      let plain: Uint8Array | null;
      try {
        plain = engine.feed(chunk);
      } catch (error) {
        this.flush();
        this.raw.end();
        this.destroy(error as Error);
        return;
      }
      this.flush();
      if (this.connecting && !engine.handshaking) this.secured();
      if (this.destroyed) return;
      if (plain === null) this.push(null);
      else if (plain.length) this.push(Buffer.from(plain.buffer, plain.byteOffset, plain.length));
    }

    // The handshake done (or, plain, the gateway's fetch() there: the
    // browser checked the certificate).
    secured() {
      this.connecting = false;
      if (this.engine) {
        const refused = this.engine.refused;
        this.authorized = refused === null;
        this.authorizationError = refused && certificateCode(refused)[0];
        this.alpnProtocol = this.engine.alpn;
        const refusal = this.authorized ? this.checkIdentity?.() : undefined;
        if (refusal) {
          this.authorized = false;
          this.authorizationError = (refusal as Error & { code?: string }).code ?? refusal.message;
          if (this.rejectUnauthorized) return void this.destroy(refusal);
        }
      }
      for (const [chunk, callback] of this.pendingWrites.splice(0)) this.send(chunk, callback);
      this.emit('secureConnect');
      this.emit('secure');
      if (this.pendingEnd) this.closeNotify(this.pendingEnd);
    }

    declare pendingEnd: ((error?: Error | null) => void) | undefined;

    _read() {}
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      if (this.connecting) this.pendingWrites.push([new Uint8Array(chunk), callback]);
      else this.send(new Uint8Array(chunk), callback);
    }
    send(chunk: Uint8Array, callback: (error?: Error | null) => void) {
      if (this.plain) {
        this.raw.write(chunk);
        return callback();
      }
      try {
        this.engine!.write(chunk);
      } catch (error) {
        return callback(error as Error);
      }
      this.flush();
      callback();
    }
    _final(callback: (error?: Error | null) => void) {
      if (this.connecting) this.pendingEnd = callback;
      else this.closeNotify(callback);
    }
    closeNotify(callback: (error?: Error | null) => void) {
      this.engine?.close();
      this.flush();
      this.raw.end();
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      this.engine?.forget();
      this.engine = null;
      this.raw.destroy();
      callback(error);
    }

    getPeerCertificate(detailed = false) {
      return this.engine ? certificate(this.engine.chain, 0, detailed) : {};
    }
    getProtocol() {
      return this.engine?.protocol ?? null;
    }
    getCipher() {
      const name = this.engine?.cipher ?? '';
      return { name, standardName: name, version: this.getProtocol() };
    }
    getSession() {
      return undefined;
    }
    isSessionReused() {
      return false;
    }
    get remoteAddress() {
      return this.raw.remoteAddress;
    }
    get remotePort() {
      return this.raw.remotePort;
    }
    get localAddress() {
      return this.raw.localAddress;
    }
    get localPort() {
      return this.raw.localPort;
    }
    address() {
      return this.raw.address?.();
    }
    setNoDelay() {
      return this;
    }
    setKeepAlive() {
      return this;
    }
    setTimeout(ms: number, callback?: () => void) {
      this.raw.setTimeout?.(ms);
      if (callback) this.once('timeout', callback);
      this.raw.on('timeout', () => this.emit('timeout'));
      return this;
    }
    ref() {
      this.raw.ref?.();
      return this;
    }
    unref() {
      this.raw.unref?.();
      return this;
    }
  }

  type ConnectOptions = TlsOptions & {
    host?: string;
    port?: number;
    socket?: Duplex;
    timeout?: number;
  };

  // connect(options, callback?), connect(port, host?, options?, callback?).
  function connect(...args: unknown[]) {
    const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : null;
    let options: ConnectOptions;
    if (args[0] && typeof args[0] === 'object') options = args[0] as ConnectOptions;
    else {
      const extra = args.find((a) => a && typeof a === 'object') as ConnectOptions | undefined;
      options = {
        ...extra,
        port: Number(args[0]),
        host: typeof args[1] === 'string' ? args[1] : extra?.host,
      };
    }
    const host = options.host ?? 'localhost';
    // HTTPS's port goes by the gateway (https.ts), as https.request does:
    // the tailnet's TCP and this TLS, else plain HTTP to its fetch(); other
    // ports (a database's TLS) by the tailnet alone.
    const raw =
      options.socket ??
      (net.module.connect({
        port: options.port,
        host,
        timeout: options.timeout,
        gateway: Number(options.port) === 443 && !net.module.isIP(host),
      }) as Duplex);
    // An address names no server (no SNI), unless the options do.
    const servername = options.servername ?? (net.module.isIP(host) ? '' : host);
    const socket = new TLSSocket(raw, { ...options, host, servername });
    if (callback) socket.once('secureConnect', callback);
    return socket;
  }

  const unavailable = (name: string) => () => {
    throw Object.assign(new Error(`tls.${name} is not available in the playground yet`), {
      code: 'ERR_NOT_IMPLEMENTED',
    });
  };

  return {
    TLSSocket,
    connect,
    createSecureContext: (options: TlsOptions = {}) => ({ context: options }),
    checkServerIdentity,
    createServer: unavailable('createServer'),
    Server: unavailable('Server'),
    getCiphers: () => [
      'tls_aes_128_gcm_sha256',
      'tls_aes_256_gcm_sha384',
      'tls_chacha20_poly1305_sha256',
      'ecdhe-ecdsa-aes128-gcm-sha256',
      'ecdhe-ecdsa-aes256-gcm-sha384',
      'ecdhe-rsa-aes128-gcm-sha256',
      'ecdhe-rsa-aes256-gcm-sha384',
    ],
    get rootCertificates() {
      return rootCertificates(files);
    },
    // Node's: the bundled roots by default; no system's or extra ones.
    getCACertificates: (type = 'default') =>
      type === 'default' || type === 'bundled' ? [...rootCertificates(files)] : [],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_ECDH_CURVE: 'auto',
    DEFAULT_CIPHERS: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  };
}

export type Tls = ReturnType<typeof createTls>;
