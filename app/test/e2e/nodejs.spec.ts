import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

// node (programs/nodejs.ts, runtime/nodejs/): scripts on the page's
// JavaScript engine in a worker of their own, over the project's files.
test('node runs scripts, modules and packages over the project files', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);

  expect(await run(page, 'node --version')).toMatch(/v24\.\d+\.\d+/);
  const evaluated = await run(
    page,
    `node -e "console.log(1 + 1, require('path').join('a', '..', 'b'), { a: [1, 2] })"`,
  );
  expect(evaluated).toContain('2 b { a: [ 1, 2 ] }');
  expect(await run(page, `node -p "process.platform + ':' + process.cwd()"`)).toContain(
    'linux:/work',
  );

  // CommonJS: fs both ways, a timer that keeps it alive, its exit code.
  await writeText(
    page,
    '/work/cjs.js',
    [
      "const fs = require('fs');",
      "fs.mkdirSync('out/deep', { recursive: true });",
      "fs.writeFileSync('out/deep/a.txt', 'from node');",
      "console.log('read', fs.readFileSync('out/deep/a.txt', 'utf8'), fs.readdirSync('out'));",
      "setTimeout(() => { console.log('later', process.argv.slice(2).join(',')); process.exitCode = 3; }, 50);",
    ].join('\n'),
  );
  const cjs = await run(page, 'node cjs.js x y; echo "status $?"');
  expect(cjs).toContain("read from node [ 'deep' ]");
  expect(cjs).toContain('later x,y');
  expect(cjs).toContain('status 3');
  expect(await readText(page, '/work/out/deep/a.txt')).toBe('from node');

  // An ES module: a package in node_modules by its exports, a JSON file,
  // top-level await, import.meta and fs/promises.
  await run(page, 'mkdir -p node_modules/greet');
  await writeText(
    page,
    '/work/node_modules/greet/package.json',
    JSON.stringify({ name: 'greet', type: 'module', exports: { '.': { import: './index.js' } } }),
  );
  await writeText(
    page,
    '/work/node_modules/greet/index.js',
    'export default (name) => `hello ${name}`;\nexport const loud = (s) => s.toUpperCase();\n',
  );
  await writeText(page, '/work/data.json', '{"n": 42}');
  await writeText(
    page,
    '/work/esm.mjs',
    [
      "import greet, { loud } from 'greet';",
      "import { readFile } from 'node:fs/promises';",
      "import { createRequire } from 'node:module';",
      "const data = createRequire(import.meta.url)('./data.json');",
      "const text = await readFile(new URL('./data.json', import.meta.url), 'utf8');",
      "console.log(loud(greet('esm')), data.n, JSON.parse(text).n, import.meta.filename);",
    ].join('\n'),
  );
  expect(await run(page, 'node esm.mjs')).toContain('HELLO ESM 42 42 /work/esm.mjs');

  // TypeScript, its types stripped.
  await writeText(
    page,
    '/work/types.ts',
    'const add = (a: number, b: number): number => a + b;\ninterface X { y: string }\nconsole.log(`sum ${add(2, 3)}`);\n',
  );
  expect(await run(page, 'node types.ts')).toContain('sum 5');

  // An uncaught error: its stack, and status 1.
  await writeText(page, '/work/bad.js', "function boom() { throw new Error('kaput'); }\nboom();\n");
  const bad = await run(page, 'node bad.js; echo "status $?"');
  expect(bad).toContain('Error: kaput');
  expect(bad).toContain('at boom');
  expect(bad).toContain('status 1');

  // From a node: System.cmd finds node on PATH.
  const cmd = await run(page, `elixir -e 'IO.inspect(System.cmd("node", ["-p", "6 * 7"]))'`);
  expect(cmd).toContain('{"42\\n", 0}');
});
