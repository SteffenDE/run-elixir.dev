// git's test scripts (GIT_T: names or globs under t/, default t0000-basic)
// against git.wasm (harness.ts): each script's TAP, a summary, and
// target/git/t-results.json (t-progress.log as each ends; GIT_T_SHARD
// splits them among runs). A script's own failures are reported, not
// failed on: the suite is how far git.wasm has come. A script past
// GIT_T_LIMIT seconds (300) is ended.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { BUILD, machine, results, type Result } from './harness';

const LIMIT = Number(process.env.GIT_T_LIMIT ?? 300);
// GIT_T_SHARD=I/N: every Nth script from the Ith (from 0), its files of its own.
const [shard, shards] = (process.env.GIT_T_SHARD ?? '0/1').split('/').map(Number);
const suffix = shards > 1 ? `-${shard}` : '';
const progress = new URL(`../../../target/git/t-progress${suffix}.log`, import.meta.url);
const wanted = (process.env.GIT_T ?? 't0000-basic').split(/[\s,]+/).filter(Boolean);
const scripts = readdirSync(`${BUILD}/t`)
  .filter((name) => /^t\d{4}-.*\.sh$/.test(name))
  .filter((name) => wanted.some((want) => new RegExp(`^${want.replace(/\*/g, '.*')}`).test(name)))
  .sort()
  .filter((_, index) => index % shards === shard);

test(`git's t/: ${scripts.length} scripts`, async () => {
  expect(scripts.length).toBeGreaterThan(0);
  const scratch = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/git-t-`);
  const output = `${BUILD}/t/results`;
  mkdirSync(output, { recursive: true });
  writeFileSync(progress, '');
  const all: Result[] = [];
  for (const script of scripts) {
    const box = machine(scratch);
    const started = performance.now();
    const env = {
      PATH: `${BUILD}:${BUILD}/t/helper:/usr/bin:/bin`,
      HOME: scratch,
      TERM: 'dumb',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: scratch,
      // git from the build's tree (GIT_EXEC_PATH), not bin-wrappers' scripts:
      // test-lib reads the option's variable, nested scripts too.
      no_bin_wrappers: 't',
    };
    let late = false;
    const limit = setTimeout(() => {
      late = true;
      box.kill();
    }, LIMIT * 1000);
    const { status, output: tap } = await box.run(
      'sh',
      [script, '--verbose-log', '-x'],
      `${BUILD}/t`,
      env,
    );
    clearTimeout(limit);
    const result = results(script, status, tap, (performance.now() - started) / 1000);
    result.timedOut = late;
    all.push(result);
    writeFileSync(`${output}/${script.replace(/\.sh$/, '.out')}`, tap);
    const line =
      `${script}: status ${status}${late ? ' (timed out)' : ''}, ${result.passed.length} passed, ${result.failed.length} failed, ${result.known} known, ${result.seconds.toFixed(1)} s` +
      (result.failed.length
        ? `\n  failed: ${result.failed.map((f) => `${f.number} ${f.title}`).join('\n          ')}`
        : '') +
      `\n  host: ${[...box.hosted].map(([name, n]) => `${name}×${n}`).join(' ')}`;
    // As each ends (vitest shows a test's output only at its end).
    appendFileSync(progress, `${line}\n`);
    console.log(line);
  }
  writeFileSync(
    new URL(`../../../target/git/t-results${suffix}.json`, import.meta.url),
    JSON.stringify(all, null, 2),
  );
});
