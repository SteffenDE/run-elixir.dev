// Bridge mode's measurements (docs/frames.md, "Bridge mode"): the test
// embedder (app/test/embedder, served by runtime/serve.py) runs projects
// in today's mode (its own usercontent domain), and in bridge mode; each
// with a
// cold HTTP cache (a new browser context) and a warm one (the same
// context, the page loaded again). Against a built site
// (python3 -I runtime/build.py first). Prints one JSON line per run and a
// table of medians.
//
//   node tests/bridge/bench.mjs [--browsers chromium,firefox,webkit]
//     [--modes legacy,bridge] [--runs 3]
//     [--only elixir,phoenix,compile,busy,ash,claude]
//
// serve.py runs with --immutable: the packages' files are cached as
// production caches them.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '../../node_modules/playwright/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const PORT = Number(arg('port', 8097));
const browsers = arg('browsers', 'chromium,firefox,webkit').split(',');
const modes = arg('modes', 'legacy,bridge').split(',');
const runs = Number(arg('runs', 3));
const only = arg('only', 'elixir,phoenix,compile,busy').split(',');
const EMBEDDER = `http://embedder.localhost:${PORT}/`;

const server = spawn(
  'python3',
  [
    '-I',
    join(root, 'runtime/serve.py'),
    String(PORT),
    '--domain', `playground.localhost:${PORT}`,
    '--usercontent', `usercontent.localhost:${PORT}`,
    '--embedders', `http://embedder.localhost:${PORT}`,
    '--embedder-host', `embedder.localhost:${PORT}`,
    '--embedder-root', join(root, 'app/test/embedder'),
    '--bridge', `bridge.localhost:${PORT}`,
    '--nif', join(root, 'target/test-nif'),
    '--immutable',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());
await new Promise((resolve) => setTimeout(resolve, 1000));

// In the page: a sandbox of `project` in `mode`, and what `task` measures;
// main-thread busy time while it boots (long tasks where the browser has
// them; else the timer's lag past 50 ms).
async function measure(page, mode, project, task, busy, id) {
  // Not `load`: Playwright's Firefox waits for a frame of another site's
  // load forever (docs/frames.md, Tests in Firefox).
  await page.goto(EMBEDDER, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.embed);
  return page.evaluate(
    async ({ mode, project, task, busy, id }) => {
      const main = { longtasks: null, lag: 0 };
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        main.longtasks = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) main.longtasks += entry.duration;
        }).observe({ type: 'longtask' });
      }
      let last = performance.now();
      const lag = setInterval(() => {
        const now = performance.now();
        if (now - last > 60) main.lag += now - last - 10;
        last = now;
      }, 10);
      // A page whose own work keeps its main thread busy: 100 ms of every
      // 150 ms (an IDE's UI at its worst).
      let jank = null;
      if (busy)
        jank = setInterval(() => {
          const until = performance.now() + 100;
          while (performance.now() < until);
        }, 150);
      const options = mode === 'legacy' ? window.embed.options : window.embed.bridged();
      // The same id in a context's runs: its warm run reopens the project
      // (its origins, and in bridge mode their service worker, known).
      const source = {
        id,
        ...(project === 'phoenix' ? { template: await window.embed.template } : { template: 'empty' }),
      };
      const started = performance.now();
      const sandbox = (window.sandbox = await window.embed.create({
        ...options,
        project: source,
        container: document.getElementById('frames'),
      }));
      const created = performance.now() - started;
      const sh = async (line) => {
        const process = sandbox.sh(line);
        let out = '';
        process.onStdout((bytes) => (out += new TextDecoder().decode(bytes)));
        process.onStderr((bytes) => (out += new TextDecoder().decode(bytes)));
        const { code } = await process.exited;
        return { out, code };
      };
      const result = { created };
      if (task === 'elixir') {
        const { out } = await sh('elixir -e "IO.puts(6 * 7)"');
        result.ok = out === '42\n';
        result.total = performance.now() - started;
      } else if (task === 'phoenix') {
        const server = sandbox.sh('mix phx.server');
        let out = '';
        await new Promise((resolve) => {
          const keep = (bytes) => {
            out += new TextDecoder().decode(bytes);
            if (/Running PlaygroundWeb.Endpoint/.test(out)) resolve();
          };
          server.onStdout(keep);
          server.onStderr(keep);
        });
        const stream = await sandbox.connect(4000);
        const answer = await new Promise((resolve) => {
          let text = '';
          stream.onData((bytes) => (text += new TextDecoder().decode(bytes)));
          stream.onEnd(() => resolve(text));
          stream.onClose(() => resolve(text));
          stream.write('GET / HTTP/1.1\r\nhost: localhost:4000\r\nconnection: close\r\n\r\n');
        });
        result.ok = /^HTTP\/1\.1 200/.test(answer);
        result.total = performance.now() - started;
      } else if (task === 'compile') {
        await sh('cd /work && mix new demo > /dev/null');
        const before = performance.now();
        const { out, code } = await sh('cd /work/demo && mix compile');
        result.ok = code === 0 && /Generated demo app/.test(out);
        result.compile = performance.now() - before;
        result.total = performance.now() - started;
      } else if (task === 'ash') {
        // A big project: Ash and its dependencies from Hex (fetched
        // untimed), then `mix compile` timed.
        await sh('cd /work && mix new big > /dev/null');
        const mix = new TextDecoder().decode(await sandbox.fs.read('/work/big/mix.exs'));
        await sandbox.fs.write(
          '/work/big/mix.exs',
          mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:ash, "~> 3.0"},'),
        );
        await sh('cd /work/big && mix deps.get');
        const before = performance.now();
        const { out, code } = await sh('cd /work/big && mix compile');
        result.ok = code === 0 && /Generated big app/.test(out);
        result.compile = performance.now() - before;
        result.total = performance.now() - started;
      } else if (task === 'claude') {
        const { out } = await sh('claude --version');
        result.ok = /Claude Code/.test(out);
        result.version = out.trim();
        result.total = performance.now() - started;
      }
      clearInterval(lag);
      if (jank) clearInterval(jank);
      const { reads } = await sandbox.exec.call('debug');
      result.reads = reads;
      result.main = main;
      await sandbox.shutdown();
      // As the IDE does as it is left (app/src/shared/lib/leave.ts): Playwright's
      // Firefox does not leave a page with a frame of another site in it.
      for (const frame of document.querySelectorAll('iframe')) frame.remove();
      return result;
    },
    { mode, project, task, busy, id },
  );
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const summary = (tally) =>
  tally && {
    count: tally.count,
    mb: +(tally.bytes / 1e6).toFixed(1),
    p50: +(percentile(tally.millis, 50) ?? 0).toFixed(2),
    p95: +(percentile(tally.millis, 95) ?? 0).toFixed(2),
  };

const TASKS = {
  elixir: { project: 'empty', task: 'elixir' },
  phoenix: { project: 'phoenix', task: 'phoenix' },
  compile: { project: 'empty', task: 'compile' },
  // Ash's compile (with its dependencies): a big project.
  ash: { project: 'empty', task: 'ash' },
  // The Phoenix boot again, with the page's main thread busy (warm only).
  busy: { project: 'phoenix', task: 'phoenix', busy: true, warmOnly: true },
  // Claude Code with its frame's cache warm: prepared in the first load.
  claude: { project: 'empty', task: 'claude', warmOnly: true },
};

const results = [];
for (const browserName of browsers) {
  const browser = await { chromium, firefox, webkit }[browserName].launch({
    args: browserName === 'chromium' ? ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] : [],
  });
  for (const name of only) {
    const { project, task, busy = false, warmOnly = false } = TASKS[name];
    for (const mode of modes)
      for (let run = 0; run < runs; run++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          for (const cache of ['cold', 'warm']) {
            const result = await measure(
              page,
              mode,
              project,
              task,
              busy && cache === 'warm',
              `bench-${name}-${mode}-${run}`,
            );
            if (cache === 'cold' && warmOnly) continue;
            const line = {
              browser: browserName,
              version: browser.version(),
              task: name,
              mode,
              cache,
              run,
              ok: result.ok,
              created: Math.round(result.created),
              total: Math.round(result.total),
              compile: result.compile && Math.round(result.compile),
              bundles: summary(result.reads?.bundles),
              other: summary(result.reads?.other),
              main: {
                longtasks: result.main.longtasks === null ? null : Math.round(result.main.longtasks),
                lag: Math.round(result.main.lag),
              },
              version_out: result.version,
            };
            results.push(line);
            console.log(JSON.stringify(line));
          }
        } catch (error) {
          const line = { browser: browserName, task: name, mode, run, error: String(error.message).slice(0, 300) };
          results.push(line);
          console.log(JSON.stringify(line));
        } finally {
          await context.close();
        }
      }
  }
  await browser.close();
}

const out = join(root, 'target', `bridge-bench-${new Date().toISOString().slice(0, 19)}.json`);
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`wrote ${out}`);
process.exit(0);
