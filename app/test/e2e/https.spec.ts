import { expect, test } from './fixtures';
import { newProject, prompted, run } from './helpers';

const GET = (url: string) =>
  `elixir -e ':inets.start(); :ssl.start(); {:ok, {{_, status, _}, headers, body}} = :httpc.request(:get, {~c"${url}", []}, [], body_format: :binary); IO.inspect {status, List.keyfind(headers, ~c"content-type", 0)}; IO.puts binary_part(body, 0, min(byte_size(body), 120))'`;

test('a node’s HTTPS goes by the page’s fetch', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // hex.pm's API sends CORS headers: httpc (over ssl) gets its JSON.
  const hex = await run(page, GET('https://hex.pm/api/packages/jason'));
  expect(hex).toContain('{200, {~c"content-type", ~c"application/json');
  expect(hex).toContain('github.com/michalmuskala/jason');
  // A site without them: the page answers why.
  const plain = await run(page, GET('https://www.example.com/'));
  expect(plain).toContain('{502,');
  expect(plain).toContain('failed in the browser');
});
