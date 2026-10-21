import { expect, test } from './fixtures';
import { newProject, output, prompted, prompts, readText, run, writeText } from './helpers';

// The terminal's shell is brush (runtime/worker/brush.ts): bash's language,
// with the playground's commands (coreutils, nodes) in its pipelines,
// substitutions and redirections.
test('brush runs pipelines, substitutions and redirections over the playground commands', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, 'x=42; echo "x=$x $((x + 1))"')).toContain('x=42 43');
  expect(await run(page, 'mkdir -p a/b && touch a/b/f a/b/g && ls a/b | wc -l')).toMatch(
    /^\s*2\s*$/m,
  );
  expect(await run(page, String.raw`printf "c\nb\na\n" | sort | head -2`)).toMatch(/a\s+b/);
  await run(page, 'echo "n=$(ls a/b | wc -l)" > a/out.txt; echo more >> a/out.txt');
  expect(await readText(page, '/work/a/out.txt')).toBe('n=2\nmore\n');
  expect(await run(page, 'wc -l < a/out.txt')).toMatch(/^\s*2\s*$/m);
  expect(await run(page, 'cd a && pwd')).toContain('/work/a');
  expect(await run(page, 'for f in b/*; do echo "[$f]"; done')).toMatch(/\[b\/f\]\s+\[b\/g\]/);
  await run(page, 'cd ..');
  // A node's output, piped.
  expect(await run(page, `elixir -e 'IO.puts(:from_node)' | tr a-z A-Z`)).toContain('FROM_NODE');
  expect(await run(page, 'ls nope 2>/dev/null || echo missing')).toContain('missing');
  expect(await run(page, 'nosuch; echo "status $?"')).toContain('status 127');
});

// Its line editor (reedline, over crossterm on the page's terminal): Tab
// completes a path and a command, Up recalls a line, and a loop typed over
// lines runs as one.
test("brush's line editor completes, recalls and continues lines", async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mkdir -p docs && echo completed > docs/notes.txt');
  const keys = (text: string) =>
    page.evaluate((data) => window.playground.sessions.get(1).node.input(data), text);
  let before = await output(page);
  await keys('cat docs/no\t');
  await expect.poll(() => output(page)).toMatch(/cat docs\/notes\.txt $/);
  await keys('\r');
  await prompted(page, prompts(before) + 1);
  expect((await output(page)).slice(before.length)).toContain('completed');
  before = await output(page);
  await keys('ech\t');
  await expect.poll(() => output(page)).toMatch(/\$ echo $/);
  await keys('again\r');
  await prompted(page, prompts(before) + 1);
  await keys('\x1b[A');
  await expect.poll(() => output(page)).toMatch(/\$ echo again$/);
  await keys('\x15for i in 1 2; do\r');
  await keys('echo "n$i"\r');
  await keys('done\r');
  await expect.poll(() => output(page)).toMatch(/n1\s+n2\s+\/work \$ $/);
});

test('oversized external output fails within a bounded pipe and leaves the shell usable', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // Finite producers keep this regression safe even if the bound breaks.
  expect(await run(page, 'seq 1 3000000 | head -n 1')).toContain('buffered output exceeded 16 MiB');
  await writeText(page, '/work/large.cjs', 'process.stdout.write("x".repeat(17 * 1024 * 1024));');
  expect(await run(page, 'node large.cjs | head -c 1')).toContain(
    'buffered output exceeded 16 MiB',
  );
  expect(await run(page, 'echo still-running')).toContain('still-running');
});
