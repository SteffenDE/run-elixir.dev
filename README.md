# Playgrounds

Elixir in the browser: Rust-OTP (`crates/rotp`) compiled to `wasm32-wasip1`,
booting OTP and Elixir from an in-memory filesystem in Web Workers.

- `elixir/`: IEx in a terminal (elixir-playground.steffend.me).
- `phoenix/`: an IDE around a `phx.new` app, with editor, shells, preview,
  PGlite and Tailwind on the page (phoenix-playground.steffend.me).
- `runtime/`: what both share: the WASI shim, workers, service worker,
  bridges, and the build.
- `tests/`: Playwright tests in Docker.

```sh
python3 -I playground/runtime/build.py phoenix        # → target/playground/phoenix
python3 -I playground/runtime/serve.py phoenix 8081   # http://localhost:8081/
```

Everything else is in [docs/](docs/README.md): architecture, the runtime's
protocols, Rust-OTP on WebAssembly, the build, the IDE, deploying (Caddy),
testing, and status.
