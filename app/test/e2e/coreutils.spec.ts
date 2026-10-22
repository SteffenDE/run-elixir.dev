import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

// uutils coreutils (coreutils.wasm, runtime/coreutils.ts): its tools in the
// shell, from a node's System.cmd, and in a node's sh -c line beside a node
// command.
test('coreutils run in the shell, from System.cmd and in sh -c', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  const started = Date.now();
  await run(page, 'mkdir -p a/b');
  console.log(`first tool: ${Date.now() - started} ms`);
  await writeText(page, '/work/a/b/x.txt', 'one\ntwo\nthree\n');
  expect(await run(page, 'wc -l a/b/x.txt')).toContain('3 a/b/x.txt');
  await run(page, 'cp -r a c');
  expect(await run(page, 'ls c/b')).toContain('x.txt');
  expect(await run(page, 'sort -r c/b/x.txt')).toMatch(/two\s+three\s+one/);
  await run(page, 'rm -rf a');
  expect(await run(page, 'ls')).not.toMatch(/\ba\b/);
  expect(await readText(page, '/work/c/b/x.txt')).toBe('one\ntwo\nthree\n');

  // A node's System.cmd finds them on PATH; its sh -c runs them, and a node
  // command among them.
  const cmd = await run(
    page,
    `elixir -e 'IO.inspect(System.cmd("rm", ["-r", "c"])); IO.inspect(File.exists?("c"))'`,
  );
  expect(cmd).toContain('{"", 0}');
  expect(cmd).toContain('false');
  const shell = await run(
    page,
    `elixir -e 'IO.inspect(System.shell("mkdir -p d/e && touch d/e/f && elixir -e \\"IO.puts(:from_node)\\" && ls d/e"))'`,
  );
  expect(shell).toContain('{"from_node\\nf\\n", 0}');
});

// A node's sh -c is brush in a worker of its own: pipes, ||, variables,
// redirections, and the playground's programs in its line.
test('System.shell runs its line as the terminal shell does', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/shell.exs',
    String.raw`started = System.monotonic_time(:millisecond)
IO.inspect(System.shell("true"))
IO.puts("sh -c true: #{System.monotonic_time(:millisecond) - started} ms")
IO.inspect(System.shell(~S[printf 'b\na\n' | sort | head -n 1]))
IO.inspect(System.shell(~S[false || echo fallback; N=5; echo $((N * 2)) > n.txt; cat n.txt]))
IO.inspect(System.shell(~S[node -p 6*7 | tr 4 x; nope 2>/dev/null; echo $?]))
`,
  );
  const out = await run(page, 'elixir shell.exs');
  console.log(out.match(/sh -c true: \d+ ms/)?.[0]);
  expect(out).toContain('{"", 0}');
  expect(out).toContain('{"a\\n", 0}');
  expect(out).toContain('{"fallback\\n10\\n", 0}');
  expect(out).toContain('{"x2\\n127\\n", 0}');
});

// ripgrep (tools/ripgrep/build.py, its own module): at the shell in the
// project's directory, honouring an ignore file (.ignore: .gitignore needs
// a git repository, as ripgrep has it), in a pipe; from a Node.js process
// (execSync) and from a node (System.cmd, by PATH).
test('rg searches the project, from the shell, Node.js and a node', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mkdir -p lib ignored');
  await writeText(page, '/work/.ignore', 'ignored/\n');
  await writeText(page, '/work/lib/a.ex', 'defmodule A do\n  # needle one\nend\n');
  await writeText(page, '/work/lib/b.ex', 'defmodule B do\nend\n');
  await writeText(page, '/work/ignored/c.ex', '# needle hidden\n');
  const found = await run(page, 'rg -n --no-heading needle');
  expect(found).toContain('lib/a.ex:2:  # needle one');
  expect(found).not.toContain('hidden');
  expect(await run(page, 'rg --files | sort')).toMatch(/lib\/a\.ex\s+lib\/b\.ex/);
  expect(await run(page, 'echo "a needle in a pipe" | rg -o needle')).toContain('needle');
  expect(
    await run(
      page,
      `node -p "require('child_process').execSync('rg -l defmodule').toString().trim()"`,
    ),
  ).toMatch(/lib\/[ab]\.ex\s+lib\/[ab]\.ex/);
  expect(
    await run(
      page,
      `elixir -e '{out, 0} = System.cmd("rg", ["-c", "defmodule", "lib"]); IO.puts(out)'`,
    ),
  ).toMatch(/lib\/a\.ex:1/);
});
