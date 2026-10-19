import { expect, test } from './fixtures';
import { newProject, prompted, readText, run } from './helpers';

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
