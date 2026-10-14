# Elixir Playground

Elixir in the browser: Rust-OTP (`crates/rotp`) compiled to `wasm32-wasip1`,
booting OTP and Elixir from an in-memory filesystem in Web Workers. One
site (elixir-playground.steffend.me) with projects kept in the browser:
Phoenix projects (a `phx.new` app, its server, PGlite, Tailwind on the
page), empty projects, and a temporary IEx.

- `app/`: the site's page, a React app (home page, project IDE) built with
  Vite, and its Playwright tests (`app/test/e2e`).
- `runtime/`: the WASI shim, workers, shared files and their storage, the
  service worker, bridges, and the build.
- `nif/`: an erl_nif for NIF libraries built to WebAssembly, and the
  builds of packages' native code (bcrypt_elixir, lazy_html).
- `tests/run.sh`: runs the Playwright tests in Docker.

```sh
python3 -I playground/nif/build.py            # → target/playground/nif (NIF builds)
python3 -I playground/runtime/build.py        # → target/playground/site
python3 -I playground/runtime/serve.py 8081   # http://localhost:8081/
playground/tests/run.sh --project=chromium    # the browser tests
```

Everything else is in [docs/](docs/README.md).
