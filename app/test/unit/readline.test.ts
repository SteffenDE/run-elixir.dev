import { EventEmitter } from 'events';
import { describe, expect, test } from 'vitest';
import { createReadline } from '../../src/runtime/nodejs/readline';

// An interface on an input that is not a terminal, and what it emits.
function lines() {
  const { readline } = createReadline();
  const input = new EventEmitter();
  const rl = readline.createInterface({ input });
  const got: string[] = [];
  rl.on('line', (line: string) => got.push(`line ${line}`));
  return { rl, got, type: (text: string) => input.emit('data', text) };
}

describe('readline', () => {
  test("a question's answer is not a line", () => {
    const { rl, got, type } = lines();
    rl.question('? ', (answer: string) => got.push(`answer ${answer}`));
    type('yes\nno\n');
    expect(got).toEqual(['answer yes', 'line no']);
  });

  test('a \\r\\n split across chunks ends one line', () => {
    const { got, type } = lines();
    type('a\r');
    type('\nb\r\n');
    type('c\r');
    type('d\n');
    expect(got).toEqual(['line a', 'line b', 'line c', 'line d']);
  });
});
