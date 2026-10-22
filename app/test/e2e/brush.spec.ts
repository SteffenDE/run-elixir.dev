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

// A pipeline's commands run at once (processes.ts): a producer that never
// ends stops when its reader does, and what flows through a pipe is
// bounded by the pipe, not by what one end holds. A page program cannot
// wait for room: what it writes ahead of its reader is bounded (16 MiB),
// and once its reader is gone, dropped.
test('pipelines stream between processes, page programs too', async ({ page }) => {
  test.setTimeout(60_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, 'yes | head -n 3')).toMatch(/y\s+y\s+y\s+\/work \$ $/);
  expect(await run(page, 'seq 1 3000000 | head -n 1')).toMatch(/^1$/m);
  expect(await run(page, 'seq 1 3000000 | tail -n 1')).toMatch(/^3000000$/m);
  await writeText(page, '/work/large.cjs', 'process.stdout.write("x".repeat(17 * 1024 * 1024));');
  const large = await run(page, 'node large.cjs | head -c 1');
  expect(large).toMatch(/^x\s*\/work \$ $/m);
  expect(large).not.toContain('exceeded');
  expect(await run(page, 'echo still-running')).toContain('still-running');
});

// A command with & runs while the shell reads the next line.
test('a job in the background runs while the shell takes commands', async ({ page }) => {
  test.setTimeout(60_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  const started = Date.now();
  await run(page, 'sleep 2 && echo late > /work/bg.txt &');
  expect(Date.now() - started).toBeLessThan(1500);
  expect(await run(page, 'echo now; ls /work')).not.toContain('bg.txt');
  await expect.poll(() => run(page, 'cat /work/bg.txt'), { timeout: 15_000 }).toContain('late');
  expect(await run(page, 'wait; echo waited')).toContain('waited');
});
