// node:dns: the machine's own names (localhost, an address as it is), and
// the rest asked of the node's DNS (runtime/dns.ts: Tailscale's resolver,
// or no such name without it, docs/tailscale.md) as DNS messages
// (`query`, net.ts). A worker thread has no network: its names are the
// machine's alone.

type Found = { address: string; family: number };
type Options = { family?: number | string; all?: boolean } | number;
export type Query = (message: Uint8Array) => Promise<Uint8Array>;

const TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33 } as const;
type Rtype = keyof typeof TYPES;
const RCODES: Record<number, string> = {
  1: 'EBADQUERY',
  2: 'ESERVFAIL',
  3: 'ENOTFOUND',
  5: 'EREFUSED',
};

const notFound = (name: string, syscall: string, code = 'ENOTFOUND') =>
  Object.assign(new Error(`${syscall} ${code} ${name}`), {
    code,
    errno: code === 'ENOTFOUND' ? -3008 : undefined,
    syscall,
    hostname: name,
  });

// A query for `name`'s records of `type`, recursion desired.
export function question(name: string, type: number, id: number): Uint8Array {
  const labels = name.replace(/\.$/, '').split('.').filter(Boolean);
  const encoder = new TextEncoder();
  const parts = labels.map((label) => encoder.encode(label));
  const out = new Uint8Array(12 + parts.reduce((n, p) => n + p.length + 1, 0) + 5);
  out.set([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  let at = 12;
  for (const part of parts) {
    out[at++] = part.length;
    out.set(part, at);
    at += part.length;
  }
  out.set([0, type >> 8, type & 255, 0, 1], at);
  return out;
}

// Eight 16-bit words as an IPv6 address, the longest run of zeros (two or
// more) as '::'.
function ipv6(words: number[]): string {
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j > i ? j : i + 1;
  }
  const hex = words.map((word) => word.toString(16));
  if (best[1] < 2) return hex.join(':');
  return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
}

// A record's data as Node answers it: an address, a name, MX, SRV, TXT.
type Answer = string | string[] | { exchange: string; priority: number } | Srv;
type Srv = { name: string; port: number; priority: number; weight: number };

// The answers of `type` in a reply, or the reply's error code.
export function answers(reply: Uint8Array, type: number): Answer[] | string {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  if (reply.length < 12) return 'EBADRESP';
  const rcode = reply[3] & 15;
  if (rcode) return RCODES[rcode] ?? 'ESERVFAIL';
  const decoder = new TextDecoder();
  // A name at `at` (compressed or not), and where it ends there.
  const nameAt = (start: number): [string, number] => {
    const labels: string[] = [];
    let at = start;
    let end = -1;
    for (let hops = 0; at < reply.length && hops < 64; hops++) {
      const length = reply[at];
      if (length === 0) {
        at++;
        break;
      }
      if ((length & 0xc0) === 0xc0) {
        if (end < 0) end = at + 2;
        at = ((length & 0x3f) << 8) | reply[at + 1];
        continue;
      }
      labels.push(decoder.decode(reply.subarray(at + 1, at + 1 + length)));
      at += length + 1;
    }
    return [labels.join('.'), end < 0 ? at : end];
  };
  let at = 12;
  for (let i = view.getUint16(4); i > 0; i--) at = nameAt(at)[1] + 4;
  const found: Answer[] = [];
  for (let i = view.getUint16(6); i > 0 && at < reply.length; i--) {
    at = nameAt(at)[1];
    const rtype = view.getUint16(at);
    const length = view.getUint16(at + 8);
    const data = at + 10;
    at = data + length;
    if (rtype !== type) continue;
    if (rtype === TYPES.A) found.push([...reply.subarray(data, data + 4)].join('.'));
    else if (rtype === TYPES.AAAA)
      found.push(ipv6(Array.from({ length: 8 }, (_, w) => view.getUint16(data + 2 * w))));
    else if (rtype === TYPES.CNAME || rtype === TYPES.NS) found.push(nameAt(data)[0]);
    else if (rtype === TYPES.MX)
      found.push({ priority: view.getUint16(data), exchange: nameAt(data + 2)[0] });
    else if (rtype === TYPES.SRV)
      found.push({
        priority: view.getUint16(data),
        weight: view.getUint16(data + 2),
        port: view.getUint16(data + 4),
        name: nameAt(data + 6)[0],
      });
    else if (rtype === TYPES.TXT) {
      const strings: string[] = [];
      for (let p = data; p < data + length; p += reply[p] + 1)
        strings.push(decoder.decode(reply.subarray(p + 1, p + 1 + reply[p])));
      found.push(strings);
    }
  }
  return found;
}

const familyOf = (options: Options = {}) =>
  typeof options === 'number' ? options : Number(String(options.family ?? 0).replace('IPv', ''));

// The machine's own name or an address, as it is; else null.
export function own(name: string, family = 0): Found[] | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return [{ address: name, family: 4 }];
  if (name.includes(':')) return [{ address: name, family: 6 }];
  if (name === 'localhost' || name.endsWith('.localhost') || !name)
    return family === 6 ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }];
  return null;
}

export function createDns(query: Query | null) {
  let nextId = Math.floor(Math.random() * 65536);
  // The records of `type` for `name`, from the node's DNS.
  const resolveType = async (name: string, type: Rtype, syscall: string): Promise<Answer[]> => {
    if (!query) throw notFound(name, syscall);
    nextId = (nextId + 1) & 0xffff;
    const found = answers(await query(question(name, TYPES[type], nextId)), TYPES[type]);
    if (typeof found === 'string') throw notFound(name, syscall, found);
    if (!found.length) throw notFound(name, syscall, 'ENODATA');
    return found;
  };
  // getaddrinfo: IPv4 first, then IPv6, as Node's default order lists.
  const find = async (name: string, options?: Options): Promise<Found[]> => {
    const family = familyOf(options);
    const local = own(name, family);
    if (local) return local;
    const of = (type: 'A' | 'AAAA', f: number) =>
      resolveType(name, type, 'getaddrinfo').then(
        (found) => (found as string[]).map((address) => ({ address, family: f })),
        (error: Error & { code?: string }) =>
          error.code === 'ENODATA' ? [] : Promise.reject(error),
      );
    const found = [
      ...(family !== 6 ? await of('A', 4) : []),
      ...(family !== 4 ? await of('AAAA', 6).catch(() => []) : []),
    ];
    if (!found.length) throw notFound(name, 'getaddrinfo');
    return found;
  };
  const lookup = async (name: string, options?: Options) => {
    const found = await find(name, options);
    return typeof options === 'object' && options.all ? found : found[0];
  };
  const addresses = (type: 'A' | 'AAAA', syscall: string) => async (name: string) =>
    own(name, type === 'A' ? 4 : 6)?.map(({ address }) => address) ??
    ((await resolveType(name, type, syscall)) as string[]);
  const resolve4 = addresses('A', 'queryA');
  const resolve6 = addresses('AAAA', 'queryAaaa');
  const records = (type: Rtype, syscall: string) => (name: string) =>
    resolveType(name, type, syscall);
  const promises = {
    lookup,
    resolve: (name: string, type: Rtype = 'A') =>
      type === 'A'
        ? resolve4(name)
        : type === 'AAAA'
          ? resolve6(name)
          : resolveType(name, type, `query${type[0]}${type.slice(1).toLowerCase()}`),
    resolve4,
    resolve6,
    resolveCname: records('CNAME', 'queryCname'),
    resolveMx: records('MX', 'queryMx'),
    resolveNs: records('NS', 'queryNs'),
    resolveSrv: records('SRV', 'querySrv'),
    resolveTxt: records('TXT', 'queryTxt'),
    setDefaultResultOrder() {},
    getDefaultResultOrder: () => 'ipv4first',
    setServers() {},
    getServers: () => (query ? ['127.0.0.53'] : []),
  };
  type Done = (...a: unknown[]) => void;
  const callback =
    (fn: (name: string, options?: never) => Promise<unknown>) =>
    (name: string, options?: unknown, done?: Done) => {
      if (typeof options === 'function') [done, options] = [options as Done, undefined];
      fn(name, options as never).then(
        (found) => done?.(null, found),
        (error) => done?.(error),
      );
    };
  return {
    // Promisified as Node's: { address, family }, or all of them.
    lookup: Object.assign(
      (name: string, options?: Options | Done, done?: Done) => {
        if (typeof options === 'function') [done, options] = [options, undefined];
        lookup(name, options).then(
          (found) =>
            Array.isArray(found) ? done?.(null, found) : done?.(null, found.address, found.family),
          (error) => done?.(error),
        );
      },
      { [Symbol.for('nodejs.util.promisify.custom')]: lookup },
    ),
    resolve: callback(promises.resolve as never),
    resolve4: callback(resolve4),
    resolve6: callback(resolve6),
    resolveCname: callback(promises.resolveCname),
    resolveMx: callback(promises.resolveMx),
    resolveNs: callback(promises.resolveNs),
    resolveSrv: callback(promises.resolveSrv),
    resolveTxt: callback(promises.resolveTxt),
    setDefaultResultOrder() {},
    getDefaultResultOrder: () => 'ipv4first',
    setServers() {},
    getServers: promises.getServers,
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    NODATA: 'ENODATA',
    NOTFOUND: 'ENOTFOUND',
    SERVFAIL: 'ESERVFAIL',
    REFUSED: 'EREFUSED',
    promises,
  };
}

export type Dns = ReturnType<typeof createDns>;
