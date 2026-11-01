// Bridge mode's bootstrap runs only on the shared usercontent domain
// (docs/frames.md, "Who may bridge"). A page of another site frames the
// apex and plays the apex's worker for a bridge bootstrap: it must not get
// its own code to run there, where its same-origin requests would reach
// the services, past their allowlist (found 2026-10-30, all three
// browsers, against serve.py: a NIF build answered 200). On the
// usercontent domain any page may run its code: it reaches no service.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { laidVersions } from './embedder';
import { PORT } from './helpers';

const APEX = `http://playground.localhost:${PORT}`;
const USERCONTENT = `usercontent.localhost:${PORT}`;
// Another site's page, from a server of its own (a page Playwright
// fulfilled would be a public one, which Chromium's Local Network Access
// keeps from framing localhost).
let stranger: Server;
let STRANGER = '';
const NIF = '/api/v1/nif/nif_fixture/0.1.0?abi=1-2.18';

// The stranger's page: `attempt(url)` frames url's /bridge.html, answers
// its bootstrap as the apex's worker would, with a page that asks for a
// NIF build from its own origin; what came of it.
const STRANGER_PAGE = String.raw`<!doctype html><body><script>
const EVIL = '<!doctype html><script>fetch("${NIF}").then((r) => r.status, () => "blocked")' +
  '.then((nif) => parent.postMessage({ kind: "evil", origin: location.origin, nif }, "*"))</' + 'script>';
window.attempt = (target, wait) => new Promise((resolve) => {
  const frame = document.createElement('iframe');
  const origin = new URL(target).origin;
  const timer = setTimeout(() => resolve({ outcome: 'nothing' }), wait);
  addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const kind = event.data && event.data.kind;
    if (kind === 'playground-bridge-loaded') {
      const control = new MessageChannel();
      control.port1.onmessage = ({ data, ports }) => {
        if (!data || data.kind !== 'serve') return;
        ports[0].onmessage = ({ ports: [reply] }) => {
          const body = new TextEncoder().encode(EVIL).buffer;
          reply.postMessage({ status: 200, headers: [['content-type', 'text/html']], body }, [body]);
        };
      };
      frame.contentWindow.postMessage(
        { kind: 'playground-bridge', protocol: 1, entry: 'npm/@elixir-playground/evil@1.0.0/x.html' },
        origin,
        [control.port2],
      );
    } else if (kind === 'playground-bridge-failed') {
      clearTimeout(timer);
      resolve({ outcome: 'failed', message: event.data.message });
    } else if (kind === 'evil') {
      clearTimeout(timer);
      resolve({ outcome: 'ran', origin: event.data.origin, nif: event.data.nif });
    }
  });
  frame.src = target;
  document.body.append(frame);
});
</script></body>`;

test.beforeAll(async () => {
  stranger = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(STRANGER_PAGE);
  });
  await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', resolve));
  STRANGER = `http://stranger.localhost:${(stranger.address() as AddressInfo).port}/`;
});
test.afterAll(() => new Promise<void>((resolve) => stranger.close(() => resolve())));

const RUNTIME = `/npm/@elixir-playground/runtime@${laidVersions().runtime}/root/bridge.html`;

test('another site runs none of its code on the apex through a bridge bootstrap', async ({
  page,
}) => {
  await page.goto(STRANGER);
  for (const path of ['/bridge.html', '/_usercontent/bridge.html', RUNTIME]) {
    // Not served there at all; and if it were, neither the bootstrap nor
    // the service worker would bridge without the shared domain's
    // /bridge.json (unit tests: bridge-bootstrap, sw-bridge).
    expect((await page.request.get(`${APEX}${path}`)).status(), path).toBe(404);
    const result = await page.evaluate(
      ([target]) => window.attempt(target, 5000),
      [`${APEX}${path}`],
    );
    expect(result, path).toEqual({ outcome: 'nothing' });
  }
  expect((await page.request.get(`${APEX}/bridge.json`)).status()).toBe(404);
});

test('another site that bridges the usercontent domain reaches no service there', async ({
  page,
}) => {
  // What the stranger's page can do (the harness works): run its code on
  // the shared domain's origins, which have no services.
  await page.goto(STRANGER);
  const origin = `http://e-abcdefghij.${USERCONTENT}`;
  const result = await page.evaluate(
    ([target]) => window.attempt(target, 15000),
    [`${origin}/bridge.html`],
  );
  expect(result).toEqual({ outcome: 'ran', origin, nif: 404 });
});

test('no other site frames the apex’s pages', async ({ page, browserName, request }) => {
  for (const path of ['/', '/abcdefghij/', '/preview.html', '/storage.html'])
    expect((await request.get(`${APEX}${path}`)).headers()['content-security-policy'], path).toBe(
      "frame-ancestors 'self'",
    );
  // A former project origin's storage.html: the apex frames it.
  expect(
    (await request.get(`http://p-abcdefghij.playground.localhost:${PORT}/storage.html`)).headers()[
      'content-security-policy'
    ],
  ).toBe(
    `frame-ancestors 'self' http://playground.localhost:${PORT} https://playground.localhost:${PORT}`,
  );
  await page.goto(STRANGER);
  await page.evaluate(
    (target) =>
      new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.onload = resolve;
        frame.src = target;
        document.body.append(frame);
        setTimeout(resolve, 5000);
      }),
    `${APEX}/`,
  );
  // Playwright's Firefox reaches no frame of another site (docs/frames.md,
  // "Tests in Firefox"): the header above is what it checks there.
  test.skip(browserName === 'firefox', 'Firefox: frames of another site are out of reach');
  const framed = page.frames().find((frame) => frame !== page.mainFrame());
  expect(framed).toBeDefined();
  // Refused: Chromium shows its error page, WebKit an empty document at
  // the apex's URL. Either way none of the apex's page (its scripts).
  const scripts = await framed!.evaluate(() => document.scripts.length).catch(() => 0);
  expect(scripts).toBe(0);
});

declare global {
  interface Window {
    attempt(
      target: string,
      wait: number,
    ): Promise<{ outcome: string; origin?: string; nif?: unknown; message?: string }>;
  }
}
