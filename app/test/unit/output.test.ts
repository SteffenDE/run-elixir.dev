import { expect, test } from 'vitest';
import { BufferedOutput, OutputLimitError } from '@/runtime/worker/output';

test('bounds stdout and stderr together before retaining more output', () => {
  const output = new BufferedOutput(6);
  output.write(1, Uint8Array.of(1, 2, 3, 4));
  output.write(2, Uint8Array.of(5, 6));
  expect(() => output.write(1, Uint8Array.of(7))).toThrow(OutputLimitError);
  const first = new Uint8Array(3);
  expect(output.read(1, first)).toBe(3);
  expect([...first]).toEqual([1, 2, 3]);
  const rest = new Uint8Array(8);
  expect(output.read(1, rest)).toBe(1);
  expect(rest[0]).toBe(4);
  expect(output.read(2, rest)).toBe(2);
  expect([...rest.slice(0, 2)]).toEqual([5, 6]);
});
