# Playground backend

A Phoenix API app for the Elixir Playground: it builds packages' NIF
libraries to WebAssembly on request, in Firecracker VMs, from templates an
agent writes. See [../docs/backend.md](../docs/backend.md).

```sh
DOCKER="sudo -n docker" mix setup   # deps, database, seeds, sandbox artifacts
mix test                            # mix test --only vm boots VMs
mix phx.server
```

Deploying: `docker-compose.yml` with `.env` (from `.env.example`).
