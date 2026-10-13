---
kind: reference
status: live
last_updated: 2026-10-13
---

# Testing

There is no gate job for the playgrounds yet. These are the checks used while
building them.

## Without a browser: `node.mjs`

The Node harness ([build.md](build.md#the-node-harness-runtimenodemjs)) runs
a site's node with the same shim. It is the quickest way to see what a node
does: boot errors, a request's status and headers, which files are fetched,
every WASI call. For example, IEx with input:

```sh
printf '1 + 1\n' | docker run --rm -i -v $PWD/playground/runtime:/w:ro \
  -v $PWD/target/playground/elixir:/d:ro node:24 node /w/node.mjs /d \
  -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex
```

It does not cover the page's parts: shared files, page programs (Tailwind),
the service worker, PGlite.

## In browsers: `playground/tests`

Playwright 1.55 in Docker, against a served site:

```sh
python3 -I playground/runtime/serve.py phoenix 8081 &
playground/tests/run.sh edit.mjs http://localhost:8081/
BROWSER=firefox playground/tests/run.sh edit.mjs http://localhost:8081/
SCHEME=dark playground/tests/run.sh edit.mjs http://localhost:8081/
```

Screenshots go to `target/playground-tests/`.

| Test | Site | Checks |
| --- | --- | --- |
| `iex.mjs URL [LINES]` | elixir | IEx's prompt, then each line's answer (lazily fetched modules included). |
| `edit.mjs` | phoenix | Open `home.html.heex` from the tree, type a heading with `text-4xl`, save; the preview shows it, and Tailwind's rebuild makes it 36px. |
| `navigate.mjs` | phoenix | The path bar goes to `/dev/dashboard` (on to `/dev/dashboard/home`) and a reload stays there. |
| `popout.mjs` | phoenix | Tab bar and path bar are the same height; the preview pops out and shows the app; the IDE docks it again. |
| `swrestart.mjs` | phoenix | Stop the service worker (CDP), reload the preview: the app shows again. |
| `shells.mjs` | phoenix | A second shell runs `mix phx.gen.live`, patches the router and migrates while the server runs; the generated form saves a post. Slow (minutes). |

`window.playground` exposes the nodes to tests. It has `node`, `output` (the
server shell's), `sessions`, `files`, `db` and `openTerminal`.

## After changing the runtime

- **Native Rust-OTP:** `ROTP_INSTALL=$PWD/target/rotp python3 -I
  scripts/test-rotp.py`, plus clippy for both targets:
  - `CARGO_TARGET_DIR=target/clippy cargo clippy -q -p rotp --all-targets --
    -D warnings`
  - `CARGO_TARGET_DIR=target/wasm cargo clippy -q --target wasm32-wasip1 -p
    rotp -- -D warnings`
- **The IDE:** `npm run lint`, `npm run format:check`, `tsc --noEmit` (part
  of `npm run build`).
- **The browsers:** `edit.mjs` in Chromium and Firefox; `iex.mjs` for the
  Elixir site.
