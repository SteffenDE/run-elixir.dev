// A participant's messages, over the relay: encrypted for the session,
// signed when the host sends them, split to fit the relay and put back
// together (docs/collaboration.md#encryption).
//
// On the wire (what the relay carries): an 8-byte sequence number, then
// the sealed bytes (crypto.ts). The additional data is the session, the
// sender (as the relay stamps it) and the sequence number, so a message
// cannot be moved to another session or sender, and a receiver drops one
// it has seen (each sender's numbers grow).
//
// Sealed inside: a kind byte, 0 for a whole message, 1 for a part of one
// (u32 message number, u16 index, u16 count, then its slice of the
// whole). A whole message: a flag byte (1: signed, then 64 bytes of
// Ed25519 signature over the SHA-256 of the session id and the rest), a
// u32 length, the JSON, and the rest: its bytes, if any.
import { open, seal, sign, utf8, verify, type Keys } from './crypto';
import { Relay, type Joined, type Role } from './relay';

// The messages' version: a guest says it, the host answers a guest that
// speaks another.
export const PROTOCOL = 3;

export interface Message {
  t: string;
  [field: string]: unknown;
}

export interface Received {
  from: string;
  message: Message;
  bytes: Uint8Array | null;
  // Signed by the host's key.
  signed: boolean;
}

export interface PeerEvents {
  joined(joined: Joined): void;
  refused(reason: string): void;
  news(event: string, payload: Record<string, unknown>): void;
  receive(received: Received): void;
}

// Parts of at most this much, sealed under the relay's 256 KiB.
const PART = 192 * 1024;

const decoder = new TextDecoder();

export class Peer {
  readonly relay: Relay;
  id: string | null = null;
  host: string | null = null;
  private sending: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  private seq = Date.now() * 1000;
  private lastSeq = new Map<string, number>();
  private parts = new Map<string, Uint8Array[]>();
  private nextMessage = 1;

  constructor(
    readonly session: string,
    role: Role,
    params: Record<string, unknown>,
    private readonly keys: Keys,
    private readonly events: PeerEvents,
  ) {
    this.relay = new Relay(
      session,
      { role, ...params },
      {
        joined: (joined) => {
          this.id = joined.id;
          this.host = joined.host;
          events.joined(joined);
        },
        refused: (reason) => events.refused(reason),
        news: (event, payload) => events.news(event, payload),
        message: (from, data) => {
          // In order, one at a time: decrypting is asynchronous.
          this.receiving = this.receiving.then(() =>
            this.unwrap(from, data).catch((error: unknown) =>
              console.warn(`live session: a message from ${from} did not open`, error),
            ),
          );
        },
      },
    );
  }

  // To everyone (`to` null) or one participant; signed if this is the host.
  send(message: Message, bytes: Uint8Array | null = null, to: string | null = null): Promise<void> {
    this.sending = this.sending.then(() =>
      this.wrap(message, bytes, to).catch((error: unknown) =>
        console.warn('live session: could not send', message.t, error),
      ),
    );
    return this.sending;
  }

  close(): void {
    this.relay.close();
  }

  private aad(from: string, seq: number): Uint8Array {
    return utf8(`${this.session}\n${from}\n${seq}`);
  }

  private async wrap(message: Message, bytes: Uint8Array | null, to: string | null): Promise<void> {
    if (!this.id) return;
    const json = utf8(JSON.stringify(message));
    const body = new Uint8Array(4 + json.length + (bytes?.length ?? 0));
    new DataView(body.buffer).setUint32(0, json.length);
    body.set(json, 4);
    if (bytes) body.set(bytes, 4 + json.length);
    let whole: Uint8Array;
    if (this.keys.sign) {
      const signature = await sign(this.keys.sign, concat(utf8(this.session), body));
      whole = concat(Uint8Array.of(1), signature, body);
    } else whole = concat(Uint8Array.of(0), body);
    if (whole.length + 1 <= PART) return this.out(concat(Uint8Array.of(0), whole), to);
    const number = this.nextMessage++;
    const count = Math.ceil(whole.length / PART);
    for (let index = 0; index < count; index++) {
      const head = new Uint8Array(9);
      const view = new DataView(head.buffer);
      head[0] = 1;
      view.setUint32(1, number);
      view.setUint16(5, index);
      view.setUint16(7, count);
      await this.out(concat(head, whole.subarray(index * PART, (index + 1) * PART)), to);
    }
  }

  private async out(plain: Uint8Array, to: string | null): Promise<void> {
    const seq = ++this.seq;
    const sealed = await seal(this.keys.key, this.aad(this.id!, seq), plain);
    const frame = new Uint8Array(8 + sealed.length);
    new DataView(frame.buffer).setBigUint64(0, BigInt(seq));
    frame.set(sealed, 8);
    if (to === null) this.relay.broadcast(frame);
    else this.relay.send(to, frame);
  }

  private async unwrap(from: string, frame: Uint8Array): Promise<void> {
    const seq = Number(new DataView(frame.buffer, frame.byteOffset).getBigUint64(0));
    if (seq <= (this.lastSeq.get(from) ?? 0)) return;
    const plain = await open(this.keys.key, this.aad(from, seq), frame.subarray(8));
    this.lastSeq.set(from, seq);
    if (plain[0] === 0) return this.whole(from, plain.subarray(1));
    const view = new DataView(plain.buffer, plain.byteOffset);
    const key = `${from}:${view.getUint32(1)}`;
    const index = view.getUint16(5);
    const count = view.getUint16(7);
    const parts = this.parts.get(key) ?? new Array<Uint8Array>(count);
    parts[index] = plain.slice(9);
    this.parts.set(key, parts);
    if (parts.filter(Boolean).length < count) return;
    this.parts.delete(key);
    return this.whole(from, concat(...parts));
  }

  private async whole(from: string, whole: Uint8Array): Promise<void> {
    let body = whole.subarray(1);
    let signed = false;
    if (whole[0] === 1) {
      const signature = whole.subarray(1, 65);
      body = whole.subarray(65);
      signed = await verify(this.keys.verify, signature, concat(utf8(this.session), body));
      if (!signed) throw new Error('a bad signature');
    }
    const length = new DataView(body.buffer, body.byteOffset).getUint32(0);
    const message = JSON.parse(decoder.decode(body.subarray(4, 4 + length))) as Message;
    const rest = body.subarray(4 + length);
    this.events.receive({ from, message, bytes: rest.length ? rest.slice() : null, signed });
  }
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}
