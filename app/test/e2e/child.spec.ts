import { expect, test } from './fixtures';
import { newProject, prompted, run, writeText } from './helpers';

// A Node.js process's child_process (docs/nodejs.md): each child a sh -c
// line in the exec frame; the synchronous forms waiting on its end, the
// asynchronous ones' stdin and kill.
test('a Node.js process runs children: execSync, spawnSync, stdin, kill', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/children.cjs',
    [
      "const cp = require('child_process');",
      'const upper = `node -e "process.stdin.on(\'data\', (d) => process.stdout.write(String(d).toUpperCase()))"`;',
      "console.log('exec', JSON.stringify(cp.execSync('echo hi && node -p 1+1', { encoding: 'utf8' })));",
      "console.log('input', cp.execSync(upper, { input: 'piped in', encoding: 'utf8' }));",
      "console.log('status', cp.spawnSync('sh', ['-c', 'exit 3']).status);",
      "try { cp.execSync('exit 2'); } catch (e) { console.log('threw', e.status); }",
      "console.log('missing', cp.spawnSync('no-such-command').error.code);",
      "const child = cp.spawn('sh', ['-c', upper]);",
      "let said = '';",
      "child.stdout.on('data', (d) => (said += d));",
      "child.stdin.write('written ');",
      "child.stdin.end('later');",
      "child.on('close', (code) => {",
      "  console.log('stdin', said, code);",
      "  const forever = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);",
      "  forever.on('exit', (code, signal) => console.log('killed', code, signal));",
      '  setTimeout(() => forever.kill(), 2000);',
      '});',
    ].join('\n'),
  );
  const out = await run(page, 'node children.cjs');
  expect(out).toContain('exec "hi\\n2\\n"');
  expect(out).toContain('input PIPED IN');
  expect(out).toContain('status 3');
  expect(out).toContain('threw 2');
  expect(out).toContain('missing ENOENT');
  expect(out).toContain('stdin WRITTEN LATER 0');
  expect(out).toContain('killed null SIGTERM');
});

test('a child shares the inherited output descriptor’s offset with its parent', async ({
  page,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/offset.cjs',
    `
const fs = require('fs');
const cp = require('child_process');
const fd = fs.openSync('/work/child-output', 'w+');
cp.spawn('echo', ['child'], {stdio: ['ignore', fd, fd]}).on('close', () => {
  fs.writeSync(fd, 'tail');
  fs.closeSync(fd);
  console.log('inherited:', JSON.stringify(fs.readFileSync('/work/child-output', 'utf8')));
});
`,
  );
  expect(await run(page, 'node offset.cjs')).toContain('inherited: "child\\ntail"');
});
