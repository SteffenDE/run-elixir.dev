import { describe, expect, test } from 'vitest';
import { relay, relayed } from '@/runtime/relay';

const OPEN = 1;
const OPENED = 2;
const ERROR = 3;
const DATA = 4;
const END = 5;
const CLOSE = 6;
const ACK = 7;

// A WebSocket the test answers for the relay: what the page sent, frame by
// frame, and `answer(kind, id, payload)`.
function fakeSocket({ opens = true } = {}) {
  const sent: { kind: number; id: number; payload: Uint8Array }[] = [];
  const ws = {
    binaryType: 'blob',
    readyState: 0,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send(bytes: Uint8Array) {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      sent.push({ kind: bytes[0], id: view.getUint32(1), payload: bytes.slice(5) });
    },
    close() {
      ws.onclose?.();
    },
  };
  queueMicrotask(() => (opens ? ws.onopen?.() : ws.onclose?.()));
  const answer = (kind: number, id: number, payload: Uint8Array | string = new Uint8Array()) => {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const frame = new Uint8Array(5 + bytes.length);
    frame[0] = kind;
    new DataView(frame.buffer).setUint32(1, id);
    frame.set(bytes, 5);
    ws.onmessage?.({ data: frame.buffer });
  };
  return { ws: ws as unknown as WebSocket, sent, answer };
}

const u32 = (n: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('which connections go through the relay', () => {
  test("the list's hosts without CORS, on 443", () => {
    expect(relayed('github.com', 443)).toBe(true);
    expect(relayed('codeload.github.com', 443)).toBe(true);
    expect(relayed('release-assets.githubusercontent.com', 443)).toBe(true);
    expect(relayed('gitlab.com', 443)).toBe(true);
    expect(relayed('codeberg.org', 443)).toBe(true);
    expect(relayed('pushin.eu', 443)).toBe(true);
    expect(relayed('platform.anthropic.com', 443)).toBe(true);
    // Its Messages API sends CORS headers, Claude Code's settings there not.
    expect(relayed('api.anthropic.com', 443)).toBe(true);
  });

  test('not those fetch() reaches, other ports or other hosts', () => {
    expect(relayed('api.github.com', 443)).toBe(false);
    expect(relayed('raw.githubusercontent.com', 443)).toBe(false);
    expect(relayed('github.com', 22)).toBe(false);
    expect(relayed('github.com.evil.example', 443)).toBe(false);
    expect(relayed('example.com', 443)).toBe(false);
  });
});

describe("the relay's tunnels", () => {
  test('open a connection and carry bytes both ways', async () => {
    const { ws, sent, answer } = fakeSocket();
    const opening = relay(() => ws)('github.com', 443);
    await tick();
    expect(sent[0].kind).toBe(OPEN);
    expect(new DataView(sent[0].payload.buffer).getUint16(0)).toBe(443);
    expect(new TextDecoder().decode(sent[0].payload.slice(2))).toBe('github.com');
    const id = sent[0].id;

    answer(OPENED, id);
    const tunnel = (await opening)!;
    const heard: string[] = [];
    let ended: string | null | undefined;
    tunnel.ondata = (bytes) => heard.push(new TextDecoder().decode(bytes));
    tunnel.onend = (error) => (ended = error);

    tunnel.write(new TextEncoder().encode('hello'));
    expect(sent.at(-1)).toMatchObject({ kind: DATA, id });

    answer(DATA, id, 'answer');
    expect(heard).toEqual(['answer']);
    expect(sent.at(-1)).toEqual({ kind: ACK, id, payload: u32(6) });

    tunnel.end();
    expect(sent.at(-1)).toMatchObject({ kind: END, id });
    answer(END, id);
    expect(ended).toBe(null);
  });

  test('send at most the window ahead of acknowledgements, in frames of 64 KiB', async () => {
    const { ws, sent, answer } = fakeSocket();
    const opening = relay(() => ws)('github.com', 443);
    await tick();
    const id = sent[0].id;
    answer(OPENED, id);
    const tunnel = (await opening)!;

    tunnel.write(new Uint8Array(300_000));
    const data = () => sent.filter((frame) => frame.kind === DATA);
    expect(data().map((frame) => frame.payload.length)).toEqual([65_536, 65_536, 65_536, 65_536]);

    tunnel.end();
    expect(sent.some((frame) => frame.kind === END)).toBe(false);

    answer(ACK, id, u32(65_536));
    expect(data().length).toBe(5);
    expect(data()[4].payload.length).toBe(300_000 - 4 * 65_536);
    expect(sent.at(-1)?.kind).toBe(END);
  });

  test("a refusal reads as an errno, the connection's bytes go nowhere", async () => {
    const { ws, sent, answer } = fakeSocket();
    const opening = relay(() => ws)('github.com', 443);
    await tick();
    answer(ERROR, sent[0].id, 'econnrefused');
    await expect(opening).rejects.toMatchObject({ code: 'econnrefused' });
  });

  test('a broken connection ends with its reason; close tells the relay', async () => {
    const { ws, sent, answer } = fakeSocket();
    const tunnels = relay(() => ws);
    const first = tunnels('github.com', 443);
    const second = tunnels('gitlab.com', 443);
    await tick();
    const [a, b] = sent.map((frame) => frame.id);
    answer(OPENED, a);
    answer(OPENED, b);
    const one = (await first)!;
    const two = (await second)!;

    let ended: string | null | undefined;
    one.onend = (error) => (ended = error);
    answer(ERROR, a, 'idle');
    expect(ended).toBe('idle');

    two.close();
    expect(sent.at(-1)).toMatchObject({ kind: CLOSE, id: b });
  });

  test('without the relay, fetch() after all', async () => {
    const { ws } = fakeSocket({ opens: false });
    await expect(relay(() => ws)('github.com', 443)).resolves.toBe(null);
  });
});
