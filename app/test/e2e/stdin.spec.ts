import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, output, prompted, prompts, run, writeText } from './helpers';

// A Node.js process's standard input (docs/nodejs.md): what is typed at
// the terminal, through its line discipline, as lines (and Ctrl+D their
// end), readline's questions, raw input (setRawMode: keys as typed, Ctrl+C
// one of them, the terminal's lines again after), and a pipe's bytes.

// Starts `line` and waits for `ready` in what follows it.
async function started(page: Page, line: string, ready: string | RegExp): Promise<number> {
  const before = await output(page);
  await page.evaluate((text) => window.playground.sessions.get(1).node.input(`${text}\n`), line);
  await expect
    .poll(async () => (await output(page)).slice(before.length), { timeout: 60_000 })
    .toMatch(ready);
  return prompts(before);
}

// Keys typed at the terminal (its line discipline's).
const type = (page: Page, keys: string) =>
  page.evaluate((k) => window.playground.sessions.get(1).discipline.keys(k), keys);

test('a Node.js process reads the terminal: lines, readline, raw keys, a pipe', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/lines.cjs',
    [
      "console.log('tty', process.stdin.isTTY, process.stdout.isTTY, process.stdout.columns > 0);",
      "process.stdin.on('data', (d) => console.log('got', JSON.stringify(String(d))));",
      "process.stdin.on('end', () => console.log('the end'));",
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/ask.mjs',
    [
      "import { createInterface } from 'node:readline/promises';",
      'const rl = createInterface({ input: process.stdin, output: process.stdout });',
      "const name = await rl.question('Your name? ');",
      'console.log(`hello ${name}`);',
      'rl.close();',
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/keys.cjs',
    [
      "const readline = require('readline');",
      'readline.emitKeypressEvents(process.stdin);',
      'process.stdin.setRawMode(true);',
      "console.log('raw', process.stdin.isRaw);",
      "process.stdin.on('keypress', (ch, key) => {",
      "  console.log('key', key.ctrl ? 'ctrl' : '', key.name);",
      "  if (key.ctrl && key.name === 'c') {",
      '    process.stdin.setRawMode(false);',
      '    process.exit(0);',
      '  }',
      '});',
    ].join('\n'),
  );

  // Lines as typed (echoed by the line discipline), then Ctrl+D.
  let before = await started(page, 'node lines.cjs', /tty true true true/);
  await type(page, 'hello\r');
  await expect.poll(() => output(page)).toContain('got "hello\\n"');
  await type(page, '\x04');
  await expect.poll(() => output(page)).toContain('the end');
  await prompted(page, before + 1);

  // readline's question, answered at the terminal.
  before = await started(page, 'node ask.mjs', 'Your name? ');
  await type(page, 'Ada\r');
  await expect.poll(() => output(page)).toContain('hello Ada');
  await prompted(page, before + 1);

  // Raw keys: a letter, an arrow, and Ctrl+C as a key (no interrupt).
  before = await started(page, 'node keys.cjs', 'raw true');
  await type(page, 'a');
  await expect.poll(() => output(page)).toMatch(/key {2}a/);
  await type(page, '\x1b[A');
  await expect.poll(() => output(page)).toMatch(/key {2}up/);
  await type(page, '\x03');
  await expect.poll(() => output(page)).toContain('key ctrl c');
  await prompted(page, before + 1);
  // The terminal's lines are the shell's again.
  expect(await run(page, 'echo after')).toContain('after');

  // A pipe's bytes, then their end; stdin no terminal then.
  const piped = await run(
    page,
    `echo piped | node -e "process.stdin.on('data', (d) => process.stdout.write('in ' + d)); process.stdin.on('end', () => console.log('end', process.stdin.isTTY))"`,
  );
  expect(piped).toContain('in piped');
  expect(piped).toContain('end false');
});
