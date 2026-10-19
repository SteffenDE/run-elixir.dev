import { expect, test } from './fixtures';
import { newProject, newShell, prompted, run } from './helpers';

// The node's sockets (beam/socket): UDP between its own ports, and, without
// Tailscale (docs/tailscale.md), other hosts out of reach at once and
// names not found at once (the page's DNS answers, no time-out).
const elixir = (code: string) => `elixir -e '${code}'`;

test('a node’s UDP between its ports; other hosts and names, without Tailscale', async ({
  page,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);

  // Passive, active and connected sockets on the node's own ports.
  const udp = await run(
    page,
    elixir(
      '{:ok, a} = :gen_udp.open(0, [:binary, active: false]); ' +
        '{:ok, b} = :gen_udp.open(0, [:binary, active: false]); {:ok, pb} = :inet.port(b); ' +
        ':ok = :gen_udp.send(a, {127, 0, 0, 1}, pb, "ping"); ' +
        '{:ok, {ip, _, data}} = :gen_udp.recv(b, 0, 5000); IO.inspect({:passive, ip, data}); ' +
        '{:ok, c} = :gen_udp.open(0, [:binary, active: true]); {:ok, pc} = :inet.port(c); ' +
        ':ok = :gen_udp.connect(a, {127, 0, 0, 1}, pc); :ok = :gen_udp.send(a, "pong"); ' +
        'receive do {:udp, ^c, _, _, data} -> IO.inspect({:active, data}) after 5000 -> IO.puts("none") end',
    ),
  );
  expect(udp).toContain('{:passive, {127, 0, 0, 1}, "ping"}');
  expect(udp).toContain('{:active, "pong"}');

  // Without Tailscale: no way to another host, and no names but the
  // hosts file's, each answered at once.
  const away = await run(
    page,
    elixir(
      't = System.monotonic_time(:millisecond); ' +
        'IO.inspect(:gen_tcp.connect({93, 184, 215, 14}, 80, [], 5000)); ' +
        'IO.inspect(:inet.gethostbyname(~c"www.example.com")); ' +
        'IO.inspect(:inet.gethostbyname(~c"localhost") |> elem(0)); ' +
        'IO.puts("took #{System.monotonic_time(:millisecond) - t} ms")',
    ),
  );
  expect(away).toContain('{:error, :enetunreach}');
  expect(away).toContain('{:error, :nxdomain}');
  expect(away).toContain(':ok');
  const took = Number(/took (\d+) ms/.exec(away)?.[1]);
  expect(took).toBeLessThan(1500);
});

test('UDP between two shells’ nodes, as between processes on one machine', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  const b = await newShell(page);
  // An echo server on port 41234 in the second shell; the first sends to
  // it until it answers.
  const server = run(
    page,
    elixir(
      '{:ok, s} = :gen_udp.open(41234, [:binary, active: false]); ' +
        '{:ok, {ip, port, data}} = :gen_udp.recv(s, 0, 60_000); ' +
        ':ok = :gen_udp.send(s, ip, port, "re:" <> data); IO.puts("served #{data}")',
    ),
    b,
  );
  const client = await run(
    page,
    elixir(
      '{:ok, s} = :gen_udp.open(0, [:binary, active: false]); ' +
        'ask = fn ask, n -> :gen_udp.send(s, {127, 0, 0, 1}, 41234, "hi"); ' +
        'case :gen_udp.recv(s, 0, 500) do {:ok, r} -> IO.inspect(r, label: "answer"); ' +
        '_ when n > 0 -> ask.(ask, n - 1); e -> IO.inspect(e) end end; ask.(ask, 60)',
    ),
  );
  expect(client).toContain('answer: {{127, 0, 0, 1}, 41234, "re:hi"}');
  expect(await server).toContain('served hi');
});
