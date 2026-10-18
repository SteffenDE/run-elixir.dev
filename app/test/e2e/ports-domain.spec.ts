import { expect, test } from './fixtures';
import { prompted, writeText } from './helpers';

// On a project domain the preview shows each of the app's ports on an
// origin of its own (v-ID-PORT, site.ts), so two show at once: here port
// 4000's page has port 4001's in an iframe (as Livebook's page has its
// iframe endpoint's), and a link to the other port goes to its origin.
const APEX = 'http://playground.localhost:8082';
const ORIGIN = /^http:\/\/p-([a-z0-9]{10})\.playground\.localhost:8082\/$/;

// Two ports of one app, each answering with a page of its own.
const server = (inner: string) => `
defmodule Two do
  def start(port, page) do
    {:ok, listen} = :gen_tcp.listen(port, [:binary, packet: :http_bin, active: false, reuseaddr: true])
    spawn(fn -> accept(listen, page) end)
  end

  defp accept(listen, page) do
    {:ok, socket} = :gen_tcp.accept(listen)
    spawn(fn -> answer(socket, page) end)
    accept(listen, page)
  end

  defp answer(socket, page) do
    {:ok, {:http_request, _, {:abs_path, path}, _}} = :gen_tcp.recv(socket, 0)
    headers(socket)
    html = page.(path)
    :gen_tcp.send(socket, ["HTTP/1.1 200 OK\\r\\ncontent-type: text/html\\r\\ncontent-length: ",
      Integer.to_string(byte_size(html)), "\\r\\nconnection: close\\r\\n\\r\\n", html])
    :gen_tcp.close(socket)
  end

  defp headers(socket) do
    case :gen_tcp.recv(socket, 0) do
      {:ok, :http_eoh} -> :ok
      {:ok, _} -> headers(socket)
    end
  end
end

Two.start(4001, fn path -> "<h1 id=\\"inner\\">port 4001 at #{path}</h1>" end)
Two.start(4000, fn _ -> ~s(<h1 id="outer">port 4000</h1><iframe src="${inner}/framed"></iframe><a id="other" href="http://localhost:4001/linked">4001</a>) end)
Process.sleep(:infinity)
`;

test('two ports of the app show at once, each on its own origin', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(ORIGIN);
  const id = ORIGIN.exec(page.url())![1];
  const port = (n: number) => `http://v-${id}-${n}.playground.localhost:8082`;
  await prompted(page, 1);
  await writeText(page, '/work/two.exs', server(port(4001)));
  await page.evaluate(() => window.playground.node.input('elixir two.exs\n'));
  const frame = page.frameLocator('.preview iframe');
  await expect(frame.locator('#outer')).toHaveText('port 4000', { timeout: 120_000 });
  await expect(frame.frameLocator('iframe').locator('#inner')).toHaveText('port 4001 at /framed');
  // Each on its own origin.
  expect(await page.locator('.preview iframe').getAttribute('src')).toBe(`${port(4000)}/`);
  // A link to the other port: its origin, and the path bar says so.
  await frame.locator('#other').click();
  await expect(frame.locator('#inner')).toHaveText('port 4001 at /linked');
  await expect(page.locator('.preview-bar input')).toHaveValue('localhost:4001/linked');
});
