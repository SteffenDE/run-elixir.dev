// Median tables of bench.mjs's results (target/bridge-bench-*.json), as
// Markdown: node tests/bridge/summary.mjs FILE [FILE…]
import { readFileSync } from 'node:fs';

const rows = process.argv.slice(2).flatMap((file) => JSON.parse(readFileSync(file, 'utf8')));
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const seconds = (ms) => (ms === null ? '–' : (ms / 1000).toFixed(2));
const MODES = {
  legacy: 'today',
  bridge: 'bridge',
  // Earlier runs' data modes (2026-10-29, before bridge mode kept only
  // direct reads).
  port: 'bridge, port',
  sw: 'bridge, sw',
  direct: 'bridge, direct',
  'port+shared': 'bridge, port, SharedWorker',
  'sw+shared': 'bridge, sw, SharedWorker',
};
const browsers = [...new Set(rows.map((row) => row.browser))];
const versions = Object.fromEntries(rows.filter((row) => row.version).map((row) => [row.browser, row.version]));

function table(title, task, pick, format = seconds, caches = ['cold', 'warm']) {
  console.log(`\n**${title}**\n`);
  console.log(`| Mode | ${browsers.flatMap((b) => caches.map((c) => `${b} ${c}`)).join(' | ')} |`);
  console.log(`| --- |${browsers.flatMap(() => caches.map(() => ' --- |')).join('')}`);
  for (const mode of Object.keys(MODES)) {
    const cells = browsers.flatMap((browser) =>
      caches.map((cache) => {
        const runs = rows.filter(
          (row) => row.browser === browser && row.task === task && row.mode === mode && row.cache === cache && row.ok,
        );
        const failed = rows.filter(
          (row) => row.browser === browser && row.task === task && row.mode === mode && (row.error || row.ok === false),
        ).length;
        if (!runs.length && !failed) return null;
        const value = median(runs.map(pick));
        return `${format(value)}${runs.length ? '' : ''}${failed ? ` (${failed} failed)` : ''}`;
      }),
    );
    if (cells.every((cell) => cell === null)) continue;
    console.log(`| ${MODES[mode]} | ${cells.map((cell) => cell ?? '–').join(' | ')} |`);
  }
}

console.log(`Browsers: ${browsers.map((b) => `${b} ${versions[b]}`).join(', ')}. Medians of ${median(
  Object.values(
    rows.reduce((counts, row) => {
      const key = `${row.browser}${row.task}${row.mode}${row.cache}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  ),
)} runs, seconds unless named.`);
table('`create()` and `elixir -e "IO.puts(6 * 7)"`, empty project', 'elixir', (row) => row.total);
table('`mix phx.server` answering on port 4000, Phoenix template', 'phoenix', (row) => row.total);
table('The same, with the page’s main thread busy 100 ms of every 150 ms', 'busy', (row) => row.total, seconds, ['warm']);
table('`mix compile` of `mix new demo`', 'compile', (row) => row.compile);
table('`mix compile` of an app depending on Ash (Ash and its dependencies)', 'ash', (row) => row.compile);
table('Bundle reads during the Ash compile (with boot): count', 'ash', (row) => row.bundles?.count, (v) => (v === null ? '–' : String(Math.round(v))));
const count = (value) => (value === null ? '–' : String(Math.round(value)));
const ms = (value) => (value === null ? '–' : value.toFixed(1));
table('Bundle reads during the Phoenix boot: count', 'phoenix', (row) => row.bundles?.count, count);
table('Bundle reads during the Phoenix boot: MB', 'phoenix', (row) => row.bundles?.mb, (v) => (v === null ? '–' : v.toFixed(1)));
table('Bundle read latency during the Phoenix boot, p50 (ms)', 'phoenix', (row) => row.bundles?.p50, ms);
table('Bundle read latency during the Phoenix boot, p95 (ms)', 'phoenix', (row) => row.bundles?.p95, ms);
table('Bundle reads during `mix compile` (with boot): count', 'compile', (row) => row.bundles?.count, count);
table('Other reads (manifests, WebAssembly, recordings) during the Phoenix boot, p50 (ms)', 'phoenix', (row) => row.other?.p50, ms);
table('Main thread during the Phoenix boot: long tasks (ms, Chromium only)', 'phoenix', (row) => row.main?.longtasks, count);
table('Main thread during the Phoenix boot: timer lag past 50 ms (ms)', 'phoenix', (row) => row.main?.lag, count);
table('Main thread during `elixir -e`: timer lag past 50 ms (ms)', 'elixir', (row) => row.main?.lag, count);
if (rows.some((row) => row.task === 'claude'))
  table('`claude --version`, the claude frame’s cache warm (create() included)', 'claude', (row) => row.total, seconds, ['warm']);
