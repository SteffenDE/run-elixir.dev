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
  // What starts other programs: env, xargs, sh (its $0 and arguments).
  expect(await run(page, `env GREETING=hi sh -c 'echo "$GREETING from $0 $1"' me there`)).toContain(
    'hi from me there',
  );
  expect(await run(page, 'printf "a b\\nc\\n" | xargs -n 2 echo got')).toMatch(/got a b\s+got c/);
  expect(await run(page, 'ls a/b | xargs wc -c | tail -n 1')).toMatch(/0 total/);
});

// GNU sed (sed/build.py, its own module over wasi-compat/): in a pipeline,
// in place, its `e` through sh (brush, a process of the worker's), and a
// node's.
test('sed edits streams and files, and runs commands through sh', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, `printf 'one two\\n' | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'`)).toContain(
    'two one',
  );
  await writeText(page, '/work/s.txt', 'alpha\nbeta\n');
  await run(page, "sed -i 's/^/- /; /beta/d' s.txt");
  expect(await readText(page, '/work/s.txt')).toBe('- alpha\n');
  expect(await run(page, `echo x | sed 'e echo from sh: $((6 * 7))'`)).toMatch(/from sh: 42\s+x/);
  expect(await run(page, "sed -n '$=' s.txt; sed 's/(/' s.txt; echo \"status $?\"")).toMatch(
    /^1\s+sed: -e expression #1, char 4: unterminated 's' command\s+status 1/m,
  );
  expect(
    await run(
      page,
      `elixir -e '{out, 0} = System.cmd("sed", ["s/a/A/g", "s.txt"]); IO.write(out)'`,
    ),
  ).toContain('- AlphA');
});

// GNU grep and diffutils (grep/build.py, diffutils/build.py): grep's basic
// regex with back-references and -r over the tree, diff -u and cmp's
// statuses, diff3 starting diff through sh, and a node's grep.
test('grep searches and diff compares, as GNU has them', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mkdir -p t/sub');
  await writeText(page, '/work/t/a.txt', 'abab\nxyz\n');
  await writeText(page, '/work/t/sub/b.txt', 'cdcd\nab\n');
  expect(await run(page, String.raw`grep -rn '\(..\)\1' t | sort`)).toMatch(
    /t\/a\.txt:1:abab\s+t\/sub\/b\.txt:1:cdcd/,
  );
  expect(await run(page, 'printf "a1\\nb\\n" | grep -cE "[0-9]+"')).toMatch(/^1$/m);
  expect(await run(page, 'grep x nope.txt; echo "status $?"')).toMatch(
    /grep: nope\.txt: No such file or directory\s+status 2/,
  );
  await writeText(page, '/work/old.txt', 'one\ntwo\nthree\nfour\nfive\n');
  await writeText(page, '/work/new.txt', 'one\n2\nthree\nfour\nfive\n');
  await writeText(page, '/work/other.txt', 'one\ntwo\nthree\nfour\n5\n');
  const unified = await run(page, 'diff -u old.txt new.txt; echo "status $?"');
  expect(unified).toMatch(/@@ -1,5 \+1,5 @@\s+one\s+-two\s+\+2\s+three[\s\S]*status 1/);
  expect(await run(page, 'cmp old.txt new.txt; echo "status $?"')).toMatch(
    /old\.txt new\.txt differ: char 5, line 2\s+status 1/,
  );
  expect(await run(page, 'diff3 -m new.txt old.txt other.txt')).toMatch(
    /^one\s+2\s+three\s+four\s+5\s*$/m,
  );
  expect(
    await run(
      page,
      `elixir -e '{out, 0} = System.cmd("grep", ["-c", "o", "old.txt"]); IO.write(out)'`,
    ),
  ).toMatch(/^3$/m);
});

// GNU awk (gawk/build.py), as awk and gawk: fields and gawk's own
// functions, its pipes both ways and a coprocess through sh (brush), and a
// node's.
test('awk is gawk, its pipes and system() through sh', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(
    await run(page, `printf 'a 1\\nb 2\\nc 3\\n' | awk '{ s += $2 } END { print NR, s }'`),
  ).toMatch(/^3 6$/m);
  expect(
    await run(page, `gawk 'BEGIN { print gensub(/(o+)/, "<\\\\1>", "g", "foo boo") }'`),
  ).toContain('f<oo> b<oo>');
  expect(
    await run(
      page,
      `awk 'BEGIN { "echo $((6 * 7))" | getline n; print "n=" n; print "z\\ny" | "sort" }'`,
    ),
  ).toMatch(/n=42\s+y\s+z/);
  expect(
    await run(
      page,
      `awk 'BEGIN { c = "tr a-z A-Z"; print "co" |& c; close(c, "to"); c |& getline r; print r }'`,
    ),
  ).toMatch(/^CO$/m);
  expect(await run(page, `awk 'BEGIN { exit system("exit 4") }'; echo "status $?"`)).toContain(
    'status 4',
  );
  expect(
    await run(
      page,
      `elixir -e '{out, 0} = System.cmd("awk", ["BEGIN { print toupper(\\"node\\") }"]); IO.write(out)'`,
    ),
  ).toMatch(/^NODE$/m);
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
  // A compound command before the last runs beside it (more than a pipe
  // holds, from a program it starts).
  expect(await run(page, '{ seq 1 100000; echo end; } | tail -n 1')).toMatch(/^end$/m);
  expect(await run(page, 'for n in 1 2; do seq 1 50000; done | wc -l')).toMatch(/^\s*100000$/m);
  await writeText(page, '/work/large.cjs', 'process.stdout.write("x".repeat(17 * 1024 * 1024));');
  const large = await run(page, 'node large.cjs | head -c 1');
  expect(large).toMatch(/^x\s*\/work \$ $/m);
  expect(large).not.toContain('exceeded');
  expect(await run(page, 'echo still-running')).toContain('still-running');
  // A page program between two processes, its input and output streaming:
  // through it, from what never ends, and into a reader that stops.
  expect(
    await run(page, `seq 1 200000 | node -e 'process.stdin.pipe(process.stdout)' | tail -n 1`),
  ).toMatch(/^200000$/m);
  await writeText(
    page,
    '/work/enough.cjs',
    'let n = 0; process.stdin.on("data", (d) => { n += d.length; if (n > 1e6) { console.log("enough"); process.exit(0); } });',
  );
  expect(await run(page, 'yes | node enough.cjs')).toMatch(/^enough$/m);
  // All of what it wrote, up to its end, while its reader is slower.
  await writeText(
    page,
    '/work/lines.cjs',
    'for (let i = 1; i <= 200000; i++) process.stdout.write(i + "\\n");',
  );
  expect(await run(page, 'node lines.cjs | wc -c')).toMatch(/^\s*1288895$/m);
  expect(
    await run(page, `node -e 'setInterval(() => console.log("tick"), 5)' | head -n 3`),
  ).toMatch(/tick\s+tick\s+tick\s+\/work \$ $/);
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
  // A page program too.
  const node = Date.now();
  await run(
    page,
    `node -e 'setTimeout(() => require("fs").writeFileSync("/work/node.txt", "done"), 1500)' &`,
  );
  expect(Date.now() - node).toBeLessThan(1500);
  await expect.poll(() => run(page, 'cat /work/node.txt'), { timeout: 15_000 }).toContain('done');
  expect(await run(page, 'wait; echo waited')).toContain('waited');
  // A job's pid ($!) and kill: as file_system's sh -c line has them
  // (inotifywait in the background, killed once its port's input ends).
  expect(
    await run(
      page,
      'sleep 30 & PID=$!; kill -KILL $PID; echo "pid $PID killed $?"; wait; echo over',
    ),
  ).toMatch(/pid \d+ killed 0\s+(?:.*\n)*over/);
  expect(
    await run(
      page,
      `elixir -e 'p = Port.open({:spawn, "sh -c \\"read a; echo eof > /work/port.txt\\""}, [:binary]); Process.sleep(500); Port.close(p); Process.sleep(3000)'; cat /work/port.txt`,
    ),
  ).toMatch(/^eof$/m);
});
