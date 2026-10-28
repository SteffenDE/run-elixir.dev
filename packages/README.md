# Packages

The playground ships as npm packages under `@elixir-playground/`
([docs/packages.md](../docs/packages.md)). Only the JavaScript packages
have source here. The others hold WebAssembly builds and file trees, and
`runtime/build.py` makes them from other build outputs.

Nothing is published yet. `build.py` lays every package out in the site
at `npm/@elixir-playground/NAME@VERSION+ID/` and writes its published
`package.json` there. The `package.json` files in this directory are for
the npm workspace only. They are `"private"`, so npm never publishes them
by mistake.

## Source packages (this directory)

These are members of the npm workspace at the repository's root. The app
(`app/`) imports them by name, and the workspace links them to their
sources.

| Directory | Package | Contents | Built into |
| --- | --- | --- | --- |
| `runtime/` | `@elixir-playground/runtime` | The runtime's workers, the usercontent domain's frames (`exec.html`, `relay.html`, `claude.html`), the page programs, the service worker and its `/relay.html` bootstrap (`root/`) | `dist/`; the Node harness into `dist-node/` |
| `api/` | `@elixir-playground/api` | `create()` and its sandbox ([docs/api.md](../docs/api.md)) | `dist/index.js`, `dist/index.d.ts` and `dist/types/` |
| `pglite/` | `@elixir-playground/pglite` | The pglite plugin: Postgres on port 5432 for the nodes | `dist/index.js`, `dist/index.d.ts` and `dist/types/` |

`api`'s and `pglite`'s declarations come from `tsc -p tsconfig.build.json`
and `types.mjs` ([docs/api.md](../docs/api.md#types)).

The runtime's version is `runtime/src/packages/host.json`'s, with the ABI
seams it speaks. `api` and `pglite` take their versions from their
`package.json`.

## Packages `build.py` makes

`PACKAGES` in `runtime/build.py` lists them. Each published one exports
its descriptor (`index.js`, typed by `index.d.ts`), which `create()` takes as a plugin.

| Package | Contents | Made from | Published |
| --- | --- | --- | --- |
| `otp-X` | The BEAM (`beam.mjs`, `beam.emu.mjs`, `beam.wasm`) and OTP's applications (an fs layer) | `beam/build.sh`, `target/otp` | Yes |
| `elixir-X` | Elixir, IEx, Mix, ExUnit; Hex, phx_new, rebar3 (an fs layer) | The host's Elixir and Mix | Yes |
| `shell` | `brush.wasm`, `coreutils.wasm`; the terminfo entry | `brush/build.py`, `tools/coreutils/build.py` | Yes |
| `git` | `git.wasm`; its shell-script commands | `tools/git/build.py` | Yes |
| `gnu-tools` | GNU sed, grep, diffutils, gawk, find | `tools/*/build.py` | Yes |
| `ripgrep` | `rg.wasm` | `tools/ripgrep/build.py` | Yes |
| `tls` | `tls.wasm`, `roots.pem`; the nodes' CA bundle | `tls/build.py` | Yes |
| `claude` | The Claude Code range the playground was tested with | `runtime/src/programs/claude/build.ts` | Yes |
| `standard` | The preset `[shell, git, gnu-tools, ripgrep, tls, pglite()]` | Generated: it depends on packages that exist only as `build.py` output | Yes |
| `phoenix-template` | The playground's Phoenix app at `/work/playground` | `mix phx.new`, compiled in the node | No: the playground's own |
| `tailscale` | `tailscale.wasm` and Go's `wasm_exec.js` | `tailscale/build.py` | No: the playground's own |

`X` is the upstream version (`otp-29.1.2`, `elixir-1.20.4`).

## Commands

At the repository's root:

```sh
npm ci && npm run build          # every member's build
npm run typecheck                # tsc --noEmit in each member
npm test                         # vitest
npm run test:git -w packages/runtime   # git's own suite against git.wasm
python3 -I runtime/build.py app  # the site, its packages laid out
```
