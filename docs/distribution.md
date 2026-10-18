---
kind: plan
status: live
last_updated: 2026-10-18
---

# Distribution

Erlang distribution between a project's nodes: `iex --sname a` in one
terminal and `Node.connect(:a@localhost)` in another, and the reason to
want it, Livebook, whose server is one node and whose notebooks run in a
second (its standalone runtime) that connects back.

## The proof of concept (2026-10-18)

Two nodes on the Emscripten BEAM, two emulators in one Node process over
one `Network` (`beam-node.ts` with `---` between their arguments), connect
with OTP's own distribution, unchanged:

```
[0] a: a@localhost alive true
[1] b: ping pong in 17 ms, nodes [a@localhost]
[1] b: rpc "29"
[1] b: erpc {a@localhost,5050}
[1] b: got {echo,a@localhost,hello}
[1] b: 1 MB there in 4 ms (1000000)
[1] b: global on a true
[1] b: nodedown a@localhost
```

(`beam/dist/two-nodes.sh`: `net_adm:ping`, `rpc:call`, `erpc:call` with a
fun, a send to a registered name on the other node, a 1 MB binary
through `erpc`, a `global` name seen from the other node, `monitor_node`
and `nodedown`.)

What it took:

- **Patch 0004 gone.** Popcorn's `without-distribution` stubbed `dist.c`'s
  entry points with early returns and left `erl_distribution`, `erl_epmd`
  and the `inet_epmd*` modules out of kernel. The code compiles as it is;
  nothing else in the patch stack depended on it.
- **The carrier: `-proto_dist inet_epmd -inet_epmd socket`.** OTP 29's
  `inet_epmd_socket` carries distribution over the `socket` module (our
  `prim_socket` NIF, patch 0016) through a distribution controller process
  (`dist_ctrl_*`), so it needs neither the inet driver nor a port.
- **Patch 0023 (`wasm-gethostname`).** Without esock there is no
  `prim_net` NIF: `net:gethostname/0` raised `notsup` (which `global`
  asks on every connection, and crashed on), and `inet_config` named the
  host `nohost` (its inet driver UDP socket fails). Both say `localhost`
  now, so `-sname a` is `a@localhost`. (`build.sh` compiles `prim_net`
  as a preloaded module of the patch stack's now.)
- **epmd.** At first a node's port came from its name (an
  `-epmd_module` of the PoC's); the page's epmd (below) replaced it.

## In the playground (built)

- **The flags on every node** (`beam/args.ts`): `-proto_dist inet_epmd
  -inet_epmd socket` beside `-kernel inet_backend socket`. A node without
  `-sname` or `-name` is not distributed and pays nothing.
- **bin/elixir's options in the shell** (`worker/index.ts` launcher):
  `--sname`, `--name`, `--cookie`, `--hidden`, `--erl "…"`, `--boot`,
  `--erl-config`, `--logger-*-reports`, read up to the first argument that
  is none, as bin/elixir reads them, so `iex --sname a` (and Livebook's
  `elixir --erl … --hidden --cookie … --eval …`) start distributed.
- **epmd on the page** (`app/src/runtime/epmd.ts`), on 4369 for every
  node as `serve` gives PGlite 5432: `ALIVE2_REQ` (a name is registered
  while its connection lasts), `PORT_PLEASE2_REQ` and `NAMES_REQ`. OTP's
  own `erl_epmd` asks it, as would every custom epmd module that falls
  back to it (Livebook's). The page routes a connection to whichever node
  listens on the port, so a node in one worker reaches another's. A
  stopped node's connections end on the page (`Node.stop`), so its name
  goes and its peers see `nodedown`.
- **One cookie for the project's nodes**: the page's `PLAYGROUND_COOKIE`
  (random per page), given as `-setcookie` to a node whose command line
  names none. `auth` would make `~/.erlang.cookie` and insist on its
  mode, which the node's files do not keep (their modes are fixed and
  `chmod` does nothing).
- **Tests:** `beam/dist/two-nodes.sh` (the Node harness, its epmd the
  page's) and Playwright's `distribution` (two shells, Chromium, Firefox
  and WebKit, about 9 s each).
- **Size:** `beam.wasm` 5,167,786 bytes, 44 KB (0.9 %) more than without
  distribution (17 KB gzipped); `boot.tar.gz` 45 KB more.

Not yet: `iex --remsh` and `--rpc-eval` (Elixir's CLI has them; untried),
long names other than at `127.0.0.1`, file modes.

## Livebook

What Livebook (0.19.10) needs, from its source:

- **Its own epmd modules, and no epmd.** The server insists on
  `Livebook.EPMD` (it aborts otherwise); a standalone runtime gets
  `-epmd_module Elixir.Livebook.Runtime.EPMD` and the parent's port in its
  arguments, and reports its own port back by message. Both delegate the
  rest to `:erl_epmd` and take a failed registration as fine. So the
  playground sets no `-epmd_module` of its own: its epmd is the page's.
- **Long names at 127.0.0.1** (`livebook_…@127.0.0.1`), which the hosts
  file and the carrier take.
- **A child node by `Port.open({:spawn_executable, elixir}, …)`**: the
  playground's port programs run `elixir` as a node of its own (as
  `System.cmd("mix", …)` does), a peer of the server's.
- **Dependencies:** Phoenix, LiveView, Bandit, Ecto (no database), Req,
  Mint.WebSocket, protobuf, yaml_elixir, aws_credentials, … none with a
  NIF of its own.
- **Its page:** a LiveView app on a port, which the preview shows (as
  Phoenix's, WebSocket included).

### Running (2026-10-18)

Livebook 0.19.10's escript, built natively, runs in an empty project
(`LIVEBOOK_TOKEN_ENABLED=false escript livebook server`): its pages in
the preview, and a notebook's cell evaluated on its standalone runtime
(Playwright's `livebook`, `@slow`, about 12–16 s in Chromium, Firefox
and WebKit; it skips without `/livebook-escript` in the site). What that
took, beyond distribution:

- **escript's `%%!` line** (`worker/index.ts`): Mix puts `-escript main
  MODULE` there, and Livebook its `-epmd_module`; the shell's escript
  passes them to erl, as bin/escript does.
- **`NAME=value command`** in the shell, as in sh (Livebook's settings
  are environment variables), and alone, for the shell's later commands.
- **os_mon** in the build (it was configured out): Livebook starts it and
  asks memsup for the system's memory. memsup's port program is the
  node's (`programs.ts` memsup: the node's memory as the system's, its
  total the 4 GiB it may grow to); cpu_sup, disksup and os_sup do not
  start (`-os_mon start_cpu_sup false`, …: their programs are not the
  playground's). The spawn driver frames `{packet, N}` as ERTS's does
  (`host/wasm_spawn.c`), and `sh -c "PROGRAM"` with one word runs that
  program, as sh would.
- **gzip in the preview** (`bridge.ts`): Livebook's static files are only
  gzipped (Plug.Static serves them to a client that accepts gzip, 404 to
  others); the bridge asks for gzip and decompresses, since a response
  the service worker makes is not decompressed for the page.
- **A node outlives its port** (`programs/node.ts`): Livebook opens the
  runtime's port from a process that then ends, which closes the port; an
  OS process would run on, and the playground's node now does too, until
  it ends by itself or the node that started it stops. It used to be
  stopped, which looked like `noconnection` to Livebook.
- **window.playground.debug()** keeps the end of each command node's
  output, and the last that ended: Livebook's runtime's output goes
  nowhere else.

Not yet: Livebook's iframe endpoint (8081, JavaScript outputs such as
Kino's) in the preview, which shows one port; `Mix.install` in a notebook
(Hex through the page, as `mix deps.get`); NIF packages notebooks ask for
(the backend's builds); memory with two nodes (not measured).

The way there: a Livebook project kind, like Phoenix's, with Livebook in
the template (its escript, or its app built at build time), its server
started on open with the preview on 8080, and notebooks on the
standalone runtime.

## Estimate (what is left)

| Step | Work |
| --- | --- |
| A Livebook kind (its escript in the build, the server started on open, the preview on 8080) | 1 day |
| The iframe endpoint in the preview (Kino's outputs), `Mix.install` in a notebook | 1–3 days |
