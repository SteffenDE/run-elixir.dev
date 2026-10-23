// The site's TCP relay (docs/relay.md), for the HTTPS gateway (https.ts)
// without a tailnet: a TCP connection to a listed host on 443, made by the
// backend, over which the node or process does TLS itself, as through the
// tailnet. Its list is the backend's (backend/priv/relay/hosts.json); the
// relay checks it again, and that the connection's first bytes are a
// ClientHello naming the host.
//
// One WebSocket (/relay, on this frame's own origin) carries every
// connection: binary frames of a kind, a 32-bit id and a payload
// (PlaygroundWeb.RelaySocket). It opens with the first connection and
// closes LINGER after its last. Either side sends at most WINDOW bytes the
// other has not acknowledged; the page acknowledges what it hands on.
import type { Tunnel } from './https';

export { relayed } from './relayList';

const OPEN = 1;
const OPENED = 2;
const ERROR = 3;
const DATA = 4;
const END = 5;
const CLOSE = 6;
const ACK = 7;

// The backend's (Playground.Relay): its window, and the most a frame
// carries.
const WINDOW = 262_144;
const PAYLOAD = 65_536;
const LINGER = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The errno a refusal reads as (https.ts's error line).
function code(reason: string): string {
  if (reason === 'econnrefused') return 'econnrefused';
  if (/timeout|etimedout|idle/.test(reason)) return 'etimedout';
  if (reason === 'not_allowed') return 'enetunreach';
  return 'ehostunreach';
}

interface Connection {
  tunnel: Tunnel;
  opened: boolean;
  open: { resolve: (tunnel: Tunnel | null) => void; reject: (error: Error) => void };
  // The page's bytes the relay has not acknowledged, and those waiting
  // for room.
  inflight: number;
  queue: Uint8Array[];
  ending: boolean;
}

type Socket = WebSocket;

// The relay's tunnels: `tunnel(host, port)` for https.ts, which resolves
// null (fetch() after all) when the relay cannot be reached.
export function relay(connect: () => Socket = () => new WebSocket(defaultUrl())) {
  let socket: Socket | null = null;
  let ready: Promise<Socket | null> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  const connections = new Map<number, Connection>();

  const frame = (kind: number, id: number, payload: Uint8Array = new Uint8Array()) => {
    const bytes = new Uint8Array(5 + payload.length);
    bytes[0] = kind;
    new DataView(bytes.buffer).setUint32(1, id);
    bytes.set(payload, 5);
    socket?.send(bytes);
  };

  const ack = (id: number, n: number) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, n);
    frame(ACK, id, count);
  };

  function forget(id: number) {
    connections.delete(id);
    if (connections.size || linger) return;
    linger = setTimeout(() => {
      linger = null;
      if (connections.size) return;
      socket?.close();
      socket = null;
      ready = null;
    }, LINGER);
  }

  function flush(id: number, connection: Connection) {
    while (connection.queue.length && connection.inflight + connection.queue[0].length <= WINDOW) {
      const bytes = connection.queue.shift()!;
      connection.inflight += bytes.length;
      frame(DATA, id, bytes);
    }
    if (connection.ending && !connection.queue.length) {
      connection.ending = false;
      frame(END, id);
    }
  }

  function received(data: ArrayBuffer) {
    const bytes = new Uint8Array(data);
    if (bytes.length < 5) return;
    const kind = bytes[0];
    const id = new DataView(data).getUint32(1);
    const payload = bytes.subarray(5);
    const connection = connections.get(id);
    if (!connection) return;
    if (kind === OPENED) {
      connection.opened = true;
      connection.open.resolve(connection.tunnel);
    } else if (kind === DATA) {
      connection.tunnel.ondata(payload.slice());
      ack(id, payload.length);
    } else if (kind === ACK && payload.length === 4) {
      connection.inflight -= new DataView(data).getUint32(5);
      flush(id, connection);
    } else if (kind === END) {
      forget(id);
      connection.tunnel.onend(null);
    } else if (kind === ERROR) {
      forget(id);
      const reason = decoder.decode(payload);
      if (connection.opened) connection.tunnel.onend(reason);
      else connection.open.reject(Object.assign(new Error(reason), { code: code(reason) }));
    }
  }

  // The socket, once open; null if it could not be.
  function open(): Promise<Socket | null> {
    if (ready) return ready;
    return (ready = new Promise((resolve) => {
      const ws = connect();
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        socket = ws;
        resolve(ws);
      };
      ws.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) received(data);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        resolve(null);
        if (socket === ws) socket = null;
        ready = null;
        for (const [id, connection] of connections) {
          connections.delete(id);
          if (connection.opened) connection.tunnel.onend('closed');
          else connection.open.resolve(null);
        }
      };
    }));
  }

  return async function tunnel(host: string, port: number): Promise<Tunnel | null> {
    if (linger) clearTimeout(linger);
    linger = null;
    const ws = await open();
    if (!ws) return null;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const connection: Connection = {
        opened: false,
        open: { resolve, reject },
        inflight: 0,
        queue: [],
        ending: false,
        tunnel: {
          ondata: () => {},
          onend: () => {},
          write: (bytes) => {
            if (!connections.has(id)) return;
            for (let at = 0; at < bytes.length; at += PAYLOAD)
              connection.queue.push(bytes.slice(at, at + PAYLOAD));
            flush(id, connection);
          },
          end: () => {
            if (!connections.has(id)) return;
            connection.ending = true;
            flush(id, connection);
          },
          close: () => {
            if (!connections.has(id)) return;
            frame(CLOSE, id);
            forget(id);
          },
        },
      };
      connections.set(id, connection);
      const target = encoder.encode(host);
      const payload = new Uint8Array(2 + target.length);
      new DataView(payload.buffer).setUint16(0, port);
      payload.set(target, 2);
      frame(OPEN, id, payload);
    });
  };
}

// The relay on this frame's origin (the exec frame's, on the usercontent
// domain; the site's proxy passes /relay to the backend).
const defaultUrl = () => `${self.location.origin.replace(/^http/, 'ws')}/relay`;
