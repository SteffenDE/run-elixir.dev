// The site's TCP relay (runtime/relay.ts, docs/relay.md): without a
// tailnet, a node's HTTPS to a listed host that sends no CORS headers goes
// over the backend's /relay, with the node's own TLS. The site for these
// tests is served with the backend at http://localhost:4000
// (playwright.config.ts: the `live` server); without one running, they
// are skipped.
import { expect, test } from './fixtures';
import { newProject, prompted, run } from './helpers';

const LIVE = `http://playground.localhost:${Number(process.env.PORT || 8081) + 2}`;
const BACKEND = process.env.BACKEND || 'http://localhost:4000';

test.use({ baseURL: LIVE });

test.beforeAll(async ({ request }) => {
  const backend = await request.get(`${BACKEND}/socket/websocket`).catch(() => null);
  test.skip(!backend, `no backend at ${BACKEND} (mix phx.server in backend/)`);
});

const GET = (url: string) =>
  `elixir -e ':inets.start(); :ssl.start(); {:ok, {{_, status, _}, _headers, body}} = :httpc.request(:get, {~c"${url}", []}, [ssl: [verify: :verify_peer, cacerts: :public_key.cacerts_get(), customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]]], body_format: :binary); IO.inspect {:status, status}; IO.puts binary_part(body, 0, min(byte_size(body), 200))'`;

test('a node’s HTTPS to github.com goes through the relay, with its own TLS', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // github.com sends no CORS headers: by fetch() it would be a 502.
  const github = await run(page, GET('https://github.com/elixir-lang/elixir'));
  expect(github).toContain('{:status, 200}');
  expect(github).toMatch(/<!DOCTYPE html>/i);
});

test('a Node.js process’s fetch to codeberg.org goes through the relay', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  const codeberg = await run(
    page,
    `node -e "fetch('https://codeberg.org/').then(async (r) => console.log('status', r.status, (await r.text()).includes('Codeberg')))"`,
  );
  expect(codeberg).toContain('status 200 true');
});

// Not yet: the process prints its answers but does not exit, a
// connection to api.anthropic.com through the relay apparently kept open
// after its answer (seen 2026-10-23, not yet understood).
test.fixme('a Node.js process’s Messages API request goes by fetch(), its settings through the relay', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The requests the browser makes itself (the gateway's fetch()).
  const fetched: string[] = [];
  page.context().on('request', (request) => {
    if (request.url().startsWith('https://api.anthropic.com/')) fetched.push(request.url());
  });
  await newProject(page, 'empty');
  await prompted(page, 1);
  const headers = `{ 'x-api-key': 'none', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }`;
  const answer = await run(
    page,
    `node -e "Promise.all([fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: ${headers}, body: '{}' }), fetch('https://api.anthropic.com/api/claude_code/settings', { headers: ${headers} })]).then(([m, s]) => console.log('messages', m.status, 'settings', s.status))"`,
  );
  // Both answered by Anthropic (no key: 401); by fetch() the settings
  // would be a 502, as they send no CORS headers.
  expect(answer).toMatch(/messages 401 settings (401|403)/);
  expect(fetched.some((url) => url.endsWith('/v1/messages'))).toBe(true);
  expect(fetched.some((url) => url.includes('/api/claude_code/settings'))).toBe(false);
});
