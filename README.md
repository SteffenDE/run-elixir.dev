# Elixir Playground

Elixir in the browser: OTP's own emulator built to WebAssembly with
Emscripten (`beam/`), booting OTP and Elixir from an in-memory filesystem
in Web Workers. One site (elixir-playground.steffend.me) with projects
kept in the browser: Phoenix projects (a `phx.new` app, its server,
PGlite, Tailwind on the page), empty projects, and a temporary IEx.

- `app/`: the site's page, a React app (home page, project IDE) built with
  Vite, its runtime (`app/src/runtime`: the node's tree, workers, shared
  files and their storage, the service worker, bridges), and its
  Playwright tests (`app/test/e2e`).
- `beam/`: the emulator's build (OTP's erts with our patches).
- `runtime/`: the site's build (`build.py`) and a server for it
  (`serve.py`).
- `nif/`: an erl_nif for NIF libraries built to WebAssembly, and the
  builds of packages' native code (bcrypt_elixir, lazy_html).
- `tests/run.sh`: runs the Playwright tests in Docker.

```sh
python3 -I nif/build.py            # → target/nif (NIF builds)
python3 -I runtime/build.py        # → target/site
python3 -I runtime/serve.py 8081   # http://localhost:8081/
tests/run.sh --project=chromium    # the browser tests
```

Everything else is in [docs/](docs/README.md).
