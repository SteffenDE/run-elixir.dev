import { expect, test } from './fixtures';
import { newProject, prompted, run, writeText } from './helpers';

// A Node.js process's worker policy (docs/nodejs.md, The worker's policy):
// whatever browser API a script reaches for, it gets no network but the
// process's messages. Each attempt aims at what would succeed without the
// policy (the exec frame's own origin, outside the site's /b/ and /r/; a
// data: module; a worker from a URL), so "blocked" is the policy's doing.
const ESCAPES = String.raw`
const origin = location.origin;
const target = origin + '/exec.html';
const results = {};
let violations = 0;
addEventListener('securitypolicyviolation', () => violations++);
const browserFetch = (() => {
  for (let o = globalThis; o; o = Object.getPrototypeOf(o))
    if (Object.hasOwn(o, 'fetch') && o.fetch !== globalThis.fetch) return o.fetch.bind(globalThis);
  return null;
})();
const settle = (promise, ms = 3000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
const attempt = async (name, fn, ms) => {
  try {
    results[name] = await settle(fn(), ms);
  } catch (error) {
    results[name] = 'blocked';
  }
};
const opened = (socket) =>
  new Promise((resolve) => {
    socket.onopen = () => resolve('open');
    socket.onerror = () => resolve('blocked');
  });

(async () => {
  await attempt('fetch', async () => ((await browserFetch(target)).ok ? 'open' : 'blocked'));
  await attempt('xhr', async () => {
    const request = new XMLHttpRequest();
    request.open('GET', target, false);
    request.send();
    return request.status === 200 ? 'open' : 'blocked';
  });
  await attempt('import', async () => {
    await new Function('u', 'return import(u)')('data:text/javascript,export default 1');
    return 'open';
  });
  await attempt('websocket', async () => {
    const before = violations;
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/socket/websocket');
    const answer = await opened(socket);
    socket.close();
    return answer === 'open' || violations === before ? 'open' : 'blocked';
  });
  await attempt('eventsource', async () => {
    const before = violations;
    const source = new EventSource(target);
    const answer = await opened(source);
    source.close();
    return answer === 'open' || violations === before ? 'open' : 'blocked';
  });
  // The build's other workers (the BEAM's, here) carry no policy of their own.
  await attempt('worker', async () => {
    const worker = new Worker(new URL('worker.js', location.href), { type: 'module' });
    const answer = await settle(
      new Promise((resolve) => (worker.onerror = () => resolve('blocked'))),
      1500,
    );
    worker.terminate();
    return answer === 'blocked' ? 'blocked' : 'open';
  });
  await attempt('cache', async () => {
    const cache = await caches.open('policy-test');
    await cache.add(target);
    return 'open';
  });
  // A thread (a blob's worker, which inherits the policy): the browser's
  // XMLHttpRequest, synchronous, so it answers either way.
  await attempt('thread', async () => {
    const { Worker } = require('worker_threads');
    const thread = new Worker(
      "const { parentPort } = require('worker_threads');" +
        'try { const r = new XMLHttpRequest(); r.open("GET", ' + JSON.stringify(target) + ', false); r.send();' +
        ' parentPort.postMessage(r.status === 200 ? "open" : "blocked"); }' +
        ' catch { parentPort.postMessage("blocked"); }',
      { eval: true },
    );
    const answer = await new Promise((resolve) => {
      thread.once('message', resolve);
      thread.once('error', (error) => resolve('error ' + error.message));
    });
    await thread.terminate();
    return answer;
  }, 20000);
  // What the process needs still loads: the site's roots (/r/).
  results.roots = require('tls').rootCertificates.length > 0 ? 'loaded' : 'none';
  for (const [name, result] of Object.entries(results)) console.log('escape ' + name + ': ' + result);
})();
`;

test('a Node.js process reaches no network but its own', async ({ page }) => {
  test.setTimeout(180_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/escape.js', ESCAPES);
  const out = await run(page, 'node escape.js');
  for (const name of [
    'fetch',
    'xhr',
    'import',
    'websocket',
    'eventsource',
    'worker',
    'cache',
    'thread',
  ])
    expect(out, name).toContain(`escape ${name}: blocked`);
  expect(out).toContain('escape roots: loaded');
});
