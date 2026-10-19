// A DNS server for the node at 127.0.0.53, port 53 (setup.ts's inetrc):
// each query, over UDP or TCP (two bytes of length before each message),
// answered by `resolve(query)`, the DNS message as it came (the
// playground's: Tailscale's resolver, docs/tailscale.md). One that throws
// is answered SERVFAIL.
import type { Connection, UdpService } from './host/node';

export type Resolve = (query: Uint8Array) => Promise<Uint8Array>;

export const NXDOMAIN = 3;
const SERVFAIL = 2;

// Where the first question ends (a query's names are not compressed).
function questionEnd(query: Uint8Array): number {
  if (query.length < 12 || ((query[4] << 8) | query[5]) === 0) return Math.min(query.length, 12);
  let at = 12;
  while (at < query.length && query[at] !== 0) at += query[at] + 1;
  return Math.min(query.length, at + 5);
}

// The first question's name (a.b.c), or null.
export function questionName(query: Uint8Array): string | null {
  if (query.length < 13 || ((query[4] << 8) | query[5]) === 0) return null;
  const labels: string[] = [];
  let at = 12;
  while (at < query.length && query[at] !== 0) {
    labels.push(new TextDecoder().decode(query.subarray(at + 1, at + 1 + query[at])));
    at += query[at] + 1;
  }
  return labels.join('.') || null;
}

// An answer with no records: the query's id and question, and `rcode`.
export function failure(query: Uint8Array, rcode: number): Uint8Array {
  if (query.length < 12) return new Uint8Array(0);
  const end = questionEnd(query);
  const answer = query.slice(0, end);
  // QR, the query's opcode and RD; RA and the rcode. One question, no more.
  answer[2] = 0x80 | (query[2] & 0x79);
  answer[3] = 0x80 | rcode;
  answer.set([0, end > 12 ? 1 : 0, 0, 0, 0, 0, 0, 0], 4);
  return answer;
}

const answered = (resolve: Resolve, query: Uint8Array) =>
  resolve(query).catch(() => failure(query, SERVFAIL));

export function dnsUdp(resolve: Resolve): UdpService {
  return ({ address, bytes }, reply) => {
    void answered(resolve, bytes).then((answer) => reply(address, 53, answer));
  };
}

export function dnsTcp(resolve: Resolve): (connection: Connection) => void {
  return (connection) => {
    let buffer = new Uint8Array(0);
    // Answers still to come, and whether the node has ended (then the
    // connection ends after them).
    let pending = 0;
    let ended = false;
    connection.ondata = (bytes) => {
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      while (buffer.length >= 2 && buffer.length >= 2 + ((buffer[0] << 8) | buffer[1])) {
        const length = (buffer[0] << 8) | buffer[1];
        const query = buffer.slice(2, 2 + length);
        buffer = buffer.slice(2 + length);
        pending++;
        void answered(resolve, query).then((answer) => {
          const framed = new Uint8Array(2 + answer.length);
          framed.set([answer.length >> 8, answer.length & 255]);
          framed.set(answer, 2);
          connection.write(framed);
          if (--pending === 0 && ended) connection.end();
        });
      }
    };
    connection.onend = () => {
      ended = true;
      if (pending === 0) connection.end();
    };
  };
}
