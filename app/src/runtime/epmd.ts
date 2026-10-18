// epmd for a project's nodes, on the page (port 4369, as host/node.ts
// serve): the Erlang Port Mapper Daemon's protocol, as OTP's erl_epmd
// speaks it, so that `-sname a` registers a's distribution port and
// another node's Node.connect(:a@localhost) finds it, with OTP's own
// epmd client (docs/distribution.md). Every node of the project is on
// the one host, localhost.
//
// A request is a 2-byte length and the request; ALIVE2 keeps its
// connection open for as long as the node is alive (its end unregisters
// the name), the others are answered and closed.
import type { Connection } from './host/node';

export const EPMD_PORT = 4369;

const ALIVE2_REQ = 120; // 'x'
const ALIVE2_X_RESP = 118; // 'v'
const PORT_PLEASE2_REQ = 122; // 'z'
const PORT2_RESP = 119; // 'w'
const NAMES_REQ = 110; // 'n'

interface Registered {
  port: number;
  type: number;
  protocol: number;
  highest: number;
  lowest: number;
  extra: Uint8Array;
}

// The names alive in a project, and the creations handed out.
export class EpmdRegistry {
  nodes = new Map<string, Registered>();
  creation = Math.floor(Math.random() * 0x7fffffff) + 1;
}

// One connection's side of the protocol: data(bytes) as it comes,
// closed() when it ends; write(bytes) and end() answer.
export function epmdSession(
  registry: EpmdRegistry,
  write: (bytes: Uint8Array) => void,
  end: () => void,
): { data(bytes: Uint8Array): void; closed(): void } {
  let pending = new Uint8Array(0);
  let alive: string | null = null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const answer = (request: Uint8Array) => {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    if (request[0] === ALIVE2_REQ && alive === null) {
      const nameLength = view.getUint16(9);
      const name = decoder.decode(request.subarray(11, 11 + nameLength));
      const extraLength = view.getUint16(11 + nameLength);
      const reply = new Uint8Array(6);
      reply[0] = ALIVE2_X_RESP;
      if (registry.nodes.has(name)) {
        reply[1] = 1;
      } else {
        alive = name;
        registry.nodes.set(name, {
          port: view.getUint16(1),
          type: request[3],
          protocol: request[4],
          highest: view.getUint16(5),
          lowest: view.getUint16(7),
          extra: request.slice(13 + nameLength, 13 + nameLength + extraLength),
        });
        registry.creation = (registry.creation % 0xffffffff) + 1;
        new DataView(reply.buffer).setUint32(2, registry.creation);
      }
      write(reply);
      if (reply[1]) end();
      return;
    }
    if (request[0] === PORT_PLEASE2_REQ) {
      const name = decoder.decode(request.subarray(1));
      const node = registry.nodes.get(name);
      if (!node) write(new Uint8Array([PORT2_RESP, 1]));
      else {
        const nameBytes = encoder.encode(name);
        const reply = new Uint8Array(14 + nameBytes.length + node.extra.length);
        const out = new DataView(reply.buffer);
        reply[0] = PORT2_RESP;
        out.setUint16(2, node.port);
        reply[4] = node.type;
        reply[5] = node.protocol;
        out.setUint16(6, node.highest);
        out.setUint16(8, node.lowest);
        out.setUint16(10, nameBytes.length);
        reply.set(nameBytes, 12);
        out.setUint16(12 + nameBytes.length, node.extra.length);
        reply.set(node.extra, 14 + nameBytes.length);
        write(reply);
      }
      end();
      return;
    }
    if (request[0] === NAMES_REQ) {
      const lines = [...registry.nodes].map(
        ([name, node]) => `name ${name} at port ${node.port}\n`,
      );
      const text = encoder.encode(lines.join(''));
      const reply = new Uint8Array(4 + text.length);
      new DataView(reply.buffer).setUint32(0, EPMD_PORT);
      reply.set(text, 4);
      write(reply);
      end();
      return;
    }
    // Anything else (kill, stop, dump): not for a project's nodes.
    end();
  };

  return {
    data(bytes) {
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending);
      joined.set(bytes, pending.length);
      pending = joined;
      while (pending.length >= 2) {
        const length = (pending[0] << 8) | pending[1];
        if (pending.length < 2 + length) break;
        const request = pending.slice(2, 2 + length);
        pending = pending.subarray(2 + length);
        answer(request);
      }
    },
    closed() {
      if (alive !== null) registry.nodes.delete(alive);
      alive = null;
    },
  };
}

// The handler for host/node.ts serve: { [EPMD_PORT]: serveEpmd(registry) },
// one registry for the project's nodes.
export function serveEpmd(registry: EpmdRegistry): (connection: Connection) => void {
  return (connection) => {
    const session = epmdSession(
      registry,
      (bytes) => connection.write(bytes),
      () => {
        session.closed();
        connection.close();
      },
    );
    connection.ondata = (bytes) => session.data(bytes);
    connection.onend = () => {
      session.closed();
      connection.close();
    };
    connection.onclose = () => session.closed();
  };
}
