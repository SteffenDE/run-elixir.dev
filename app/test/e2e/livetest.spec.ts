// mix test in a Phoenix project, with a LiveView test: LiveViewTest parses
// with lazy_html, a NIF built to WebAssembly. The test environment's
// dependencies compile first (about 5 minutes in Chromium).
import { expect, test } from './fixtures';
import { APP, newProject, newShell, output, serverRunning, writeText } from './helpers';

const COUNTER_TEST = `defmodule PlaygroundWeb.CounterLiveTest do
  use PlaygroundWeb.ConnCase
  import Phoenix.LiveViewTest

  defmodule Counter do
    use Phoenix.LiveView
    def mount(_params, _session, socket), do: {:ok, assign(socket, n: 0)}
    def render(assigns), do: ~H|<button id="inc" phx-click="inc">count {@n}</button>|
    def handle_event("inc", _, socket), do: {:noreply, update(socket, :n, &(&1 + 1))}
  end

  test "counts", %{conn: conn} do
    {:ok, view, html} = live_isolated(conn, Counter)
    assert html =~ "count 0"
    assert view |> element("#inc") |> render_click() =~ "count 1"
    assert has_element?(view, "button#inc", "count 1")
  end
end
`;

test("mix test runs the app's tests and a LiveView test @slow", async ({ page }) => {
  test.setTimeout(3_600_000);
  await newProject(page, 'phoenix');
  await serverRunning(page);
  const shell = await newShell(page);
  await page.evaluate((p) => window.playground.files.mkdir(p), `${APP}/test/playground_web/live`);
  await writeText(page, `${APP}/test/playground_web/live/counter_live_test.exs`, COUNTER_TEST);
  await page.evaluate((id) => window.playground.sessions.get(id).node.input('mix test\n'), shell);
  await expect
    .poll(async () => ((await output(page, shell)).match(/~\S* \$ /g) ?? []).length, {
      timeout: 3_000_000,
      intervals: [5000],
    })
    .toBeGreaterThanOrEqual(2);
  const out = await output(page, shell);
  expect(out).toContain("make: lazy_html 0.1.13's native code, built to WebAssembly");
  expect(out).toContain('Result: 6 passed');
});
