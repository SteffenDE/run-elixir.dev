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

## Where it stands (2026-10-18, branch `dist-poc`)

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
- **No epmd.** A node's port comes from its name (`beam/dist/
  playground_epmd.erl`, `-epmd_module playground_epmd`): the PoC's way,
  not the playground's (below).

## For the playground

1. **The flags on every node** (`beam/args.ts`): `-proto_dist inet_epmd
   -inet_epmd socket` beside `-kernel inet_backend socket`, which it has.
   A node without `-sname`/`-name` is not distributed and pays nothing.
2. **epmd on the page.** The project's nodes are workers whose ports the
   page connects (`playground.ts` routes a connection to whichever node
   listens on the port, ephemeral ones included). An epmd server there,
   on port 4369 as `serve` already gives PGlite 5432, answers
   `ALIVE2_REQ`, `PORT_PLEASE2_REQ` and `NAMES_REQ` for all of them, so
   OTP's own `erl_epmd` works unchanged, and so does every custom epmd
   module that falls back to it (Livebook's). `playground_epmd` then goes.
3. **Tests:** the Node harness's two nodes (above, as a check job), and a
   Playwright test with two terminals, `iex --sname a` and `iex --sname
   b`, `Node.ping(:a@localhost)`: across workers, through the page.
4. **Size and speed:** `beam.wasm` with `dist.c` live again and kernel's
   distribution modules; node start without `-sname` unchanged.

## Livebook

What Livebook (0.19.10) needs, from its source:

- **Its own epmd modules, and no epmd.** The server insists on
  `Livebook.EPMD` (it aborts otherwise); a standalone runtime gets
  `-epmd_module Elixir.Livebook.Runtime.EPMD` and the parent's port in its
  arguments, and reports its own port back by message. Both delegate the
  rest to `:erl_epmd` and take a failed registration as fine. So the
  playground must not set `-epmd_module` itself: epmd on the page (2.)
  fits, a playground-wide `playground_epmd` would not.
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

The way there: a Livebook project kind, like Phoenix's, with Livebook
fetched and compiled into the template at build time (compiling it in
the tab would take minutes), its server started on open, and notebooks
on the standalone runtime. Open: memory with two nodes (each its own
emulator and memory; not measured yet), Livebook's file system (`/work`), its
Mix.install in notebooks (Hex through the page, as `mix deps.get`), and
NIF packages notebooks ask for (the backend's builds).

## Estimate

| Step | Work |
| --- | --- |
| Patches (0004 gone, 0023), the release build, the full test suite on it | ½ day |
| Flags on every node, epmd on the page, the two tests | 1–2 days |
| Livebook running in a project by hand (fetch, compile, `livebook server`, a notebook on the standalone runtime) and what that turns up | 2–4 days |
| A Livebook kind with a prebuilt template | 1–2 days |

About one to two weeks to Livebook as a project kind; distribution for
`iex --sname` shells alone, two to three days.
