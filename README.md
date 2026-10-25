# Elixir Playground

The Elixir Playground runs OTP and Elixir in the browser. OTP's emulator
is compiled to WebAssembly with Emscripten. Projects run in Web Workers,
with files and databases stored locally in IndexedDB.

Create a Phoenix app with LiveView and PGlite, an empty project, or a
temporary IEx session. The IDE also supports public repository imports,
Git diffs, sharing links, and live collaboration.

- `app/`: the React IDE, browser runtime, and Playwright tests.
- `beam/`: the OTP emulator build and Emscripten patches.
- `runtime/`: site assembly (`build.py`) and local server (`serve.py`).
- `nif/`: the WebAssembly NIF compatibility layer and package builds.
- `tools/` and `brush/`: Git, command-line tools, and the shell.
- `tailscale/` and `tls/`: Tailscale and TLS clients built to WebAssembly.
- `backend/`: NIF builds, encrypted collaboration, and the TCP relay.
- `deploy/`: build, upload, activation, and rollback scripts.

See [Build requirements](docs/build.md#requirements) before the first build.
For an existing build:

```sh
python3 -I runtime/build.py app
python3 -I runtime/serve.py 8081 \
  --domain playground.localhost:8081 --usercontent usercontent.localhost:8081
PORT=8181 tests/run.sh --project=chromium
```

Open `http://playground.localhost:8081/`. The separate usercontent domain
is required to run projects. See [the documentation index](docs/README.md)
for architecture, setup, and feature details.
