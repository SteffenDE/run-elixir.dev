import { describe, expect, test } from 'vitest';
import { Channel, END, FRAME, INPUT, RING } from '../../src/runtime/worker/channel';

// A channel, and a way to write the page's frames to it (host/node.ts's).
function channel() {
  const shared = new SharedArrayBuffer(8 + RING);
  const control = new Int32Array(shared, 0, 2);
  const ring = new Uint8Array(shared, 8, RING);
  const frame = (kind: number, id: number, payload: number[] = []) => {
    let written = Atomics.load(control, 0);
    const header = new Uint8Array(9);
    const view = new DataView(header.buffer);
    view.setUint8(0, kind);
    view.setUint32(1, id, true);
    view.setUint32(5, payload.length, true);
    for (const byte of [...header, ...payload]) ring[written++ % RING] = byte;
    Atomics.store(control, 0, written);
  };
  return { channel: new Channel(shared), frame };
}

describe("a process's input to a node", () => {
  test('is its bytes as they are, a lone 4 too, then its end', () => {
    const { channel: c, frame } = channel();
    frame(FRAME.INPUT, INPUT.PIPE, [0xe2, 0x82]);
    frame(FRAME.INPUT, INPUT.PIPE, [0xac, 0xff]);
    frame(FRAME.INPUT, INPUT.PIPE, [4]);
    frame(FRAME.INPUT, INPUT.PIPE_END);
    c.pump();
    expect(c.input.map((bytes) => (bytes === END ? 'end' : [...bytes]))).toEqual([
      [0xe2, 0x82],
      [0xac, 0xff],
      [4],
      'end',
    ]);
    // What reads the input as bytes alone has no end.
    expect([...c.take(Infinity)]).toEqual([0xe2, 0x82, 0xac, 0xff, 4]);
  });

  test('is read as far as its end, which then reads as none', () => {
    const { channel: c, frame } = channel();
    expect(c.takeInput(10)).toBeNull();
    frame(FRAME.INPUT, INPUT.PIPE, [1, 2, 3]);
    frame(FRAME.INPUT, INPUT.PIPE_END);
    frame(FRAME.INPUT, INPUT.PIPE, [5]);
    c.pump();
    expect([...c.takeInput(2)!]).toEqual([1, 2]);
    expect([...c.takeInput(10)!]).toEqual([3]);
    expect([...c.takeInput(10)!]).toEqual([]);
    expect([...c.takeInput(10)!]).toEqual([5]);
    expect(c.takeInput(10)).toBeNull();
  });

  test("from the terminal ends at Ctrl+D for what reads it, else a key's", () => {
    const { channel: c, frame } = channel();
    frame(FRAME.INPUT, INPUT.TERMINAL, [4]);
    c.pump();
    expect(c.input).toEqual([]);
    c.reading = 1;
    frame(FRAME.INPUT, INPUT.TERMINAL, [4]);
    c.pump();
    expect(c.input[0]).toBe(END);
    c.input = [];
    c.raw = true;
    frame(FRAME.INPUT, INPUT.TERMINAL, [4]);
    c.pump();
    expect(c.input[0]).not.toBe(END);
  });
});
