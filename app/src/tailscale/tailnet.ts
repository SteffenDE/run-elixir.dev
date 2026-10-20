// The tailnet for a project's nodes, in the exec frame's worker
// (exec/host.ts, docs/tailscale.md): the node's HTTPS tunnels, TCP and UDP
// to other hosts, and DNS, each asked of the IDE's page on the apex
// (client.ts), which decides whether the project may and hands the
// connection's port to the apex's Tailscale worker. The connection's bytes
// then go between this worker and that one, not through the page.
import { failure, NXDOMAIN } from '@/runtime/dns';
import type { Connection, Outbound, Reply as UdpReply, UdpRoute } from '@/runtime/host/node';
import type { Tunnel } from '@/runtime/https';
import type { Rpc } from '@/shared/lib/rpc';
import type { Piece, Proto } from './protocol';

// How a dial that failed reads as an errno (host/node.ts's refuse), and as
// a POSIX name (the HTTPS gateway's error line).
export function errno(message: string): number {
  if (/refused/i.test(message)) return -14;
  if (/timeout|deadline|timed out/i.test(message)) return -73;
  if (/not connected|not running|not allowed/i.test(message)) return -40;
  return -23;
}
export const ERRNO_NAMES: Record<number, string> = {
  [-14]: 'econnrefused',
  [-23]: 'ehostunreach',
  [-40]: 'enetunreach',
  [-73]: 'etimedout',
};

const target = (address: string, port: number) =>
  address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;

// A UDP session through the tailnet stays this long after its last
// datagram either way.
const UDP_IDLE = 120_000;

// The tailnet's ways for the nodes, through the IDE's page (`ide`).
export function tailnet(ide: Rpc) {
  // The page heard of something the node could not reach (the setup
  // hint, while Tailscale is not set up).
  const blocked = (what: string) => ide.emit('blocked', what);

  // A connection through the tailnet, or null where the page says the
  // node does not take it there (or the project may not).
  async function dial(host: string, port: number, proto: Proto): Promise<Tunnel | null> {
    const channel = new MessageChannel();
    const conn = channel.port1;
    const taken = await ide.call<boolean>(
      'tailnetDial',
      [host, port, proto, channel.port2],
      [channel.port2],
    );
    if (!taken) {
      conn.close();
      return null;
    }
    return new Promise((resolve, reject) => {
      const tunnel: Tunnel = {
        ondata: () => {},
        onend: () => {},
        write: (bytes) => {
          const copy = bytes.slice();
          conn.postMessage({ kind: 'data', bytes: copy } satisfies Piece, [copy.buffer]);
        },
        end: () => conn.postMessage({ kind: 'end' } satisfies Piece),
        close: () => {
          conn.postMessage({ kind: 'close' } satisfies Piece);
          conn.close();
        },
      };
      conn.onmessage = ({ data }: MessageEvent<Piece>) => {
        if (data.kind === 'open') {
          tunnel.local = data.local;
          resolve(tunnel);
        } else if (data.kind === 'error') {
          conn.close();
          reject(new Error(data.message));
        } else if (data.kind === 'data') tunnel.ondata(data.bytes);
        else if (data.kind === 'end') tunnel.onend(data.error ?? null);
      };
    });
  }

  // https.ts's tunnel: a TCP connection to `host` through the tailnet,
  // over which the node does TLS; null for fetch().
  const tunnel = (host: string, port: number): Promise<Tunnel | null> =>
    dial(host, port, 'tcp').catch((error: Error) => {
      throw Object.assign(error, { code: ERRNO_NAMES[errno(error.message)] });
    });

  // The node's TCP connections to other hosts (host/node.ts's outbound):
  // through the tailnet; else unreachable (ENETUNREACH), and the setup
  // hint.
  const outbound: Outbound = (connection, { address, port }) => {
    let closed = false;
    connection.onclose = () => (closed = true);
    dial(address, port, 'tcp').then(
      (opened) => {
        if (!opened) {
          blocked(target(address, port));
          if (!closed) connection.refuse(-40);
          return;
        }
        if (closed) return opened.close();
        connection.dialed(opened.local);
        pipe(connection, opened);
      },
      (error: Error) => {
        if (!closed) connection.refuse(errno(error.message));
      },
    );
  };

  // The node's datagrams to other hosts (host/node.ts's udp), for one
  // node: through the tailnet, one connected UDP socket there per port of
  // the node's and address it sends to, whose datagrams come back to that
  // port; else dropped (and the setup hint).
  function udp(): UdpRoute {
    const sessions = new Map<
      string,
      { from: number; tunnel: Promise<Tunnel | null>; timer: ReturnType<typeof setTimeout> }
    >();
    const forget = (key: string) => {
      const session = sessions.get(key);
      if (!session) return;
      sessions.delete(key);
      clearTimeout(session.timer);
      void session.tunnel.then((opened) => opened?.close());
    };
    const touch = (key: string) => {
      const session = sessions.get(key);
      if (!session) return;
      clearTimeout(session.timer);
      session.timer = setTimeout(() => forget(key), UDP_IDLE);
    };
    const start = (
      key: string,
      { from, address, port }: { from: number; address: string; port: number },
      reply: UdpReply,
    ) => {
      const opening = dial(address, port, 'udp').then(
        (opened) => {
          if (!opened) {
            blocked(target(address, port));
            sessions.delete(key);
            return null;
          }
          opened.ondata = (bytes) => {
            touch(key);
            reply(address, port, bytes);
          };
          opened.onend = () => forget(key);
          return opened;
        },
        () => {
          sessions.delete(key);
          return null;
        },
      );
      sessions.set(key, {
        from,
        tunnel: opening,
        timer: setTimeout(() => forget(key), UDP_IDLE),
      });
    };
    return {
      send: (datagram, reply) => {
        const { from, address, port, bytes } = datagram;
        const key = `${from} ${address} ${port}`;
        if (!sessions.has(key)) start(key, datagram, reply);
        touch(key);
        void sessions.get(key)?.tunnel.then((opened) => opened?.write(bytes));
      },
      unbound: (port) => {
        for (const [key, session] of sessions) if (session.from === port) forget(key);
      },
    };
  }

  // The node's DNS (runtime/dns.ts): the page's answer (Tailscale's
  // resolver, or no such name).
  const resolve = (query: Uint8Array) =>
    ide.call<Uint8Array>('tailnetResolve', [query]).catch(() => failure(query, NXDOMAIN));

  return { tunnel, outbound, udp, resolve, blocked };
}

function pipe(connection: Connection, tunnel: Tunnel): void {
  connection.ondata = (bytes) => tunnel.write(bytes);
  connection.onend = () => tunnel.end();
  connection.onclose = () => tunnel.close();
  tunnel.ondata = (bytes) => connection.write(bytes);
  tunnel.onend = () => connection.end();
}
