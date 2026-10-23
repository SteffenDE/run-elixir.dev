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
