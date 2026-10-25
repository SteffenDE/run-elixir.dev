# Playground backend

The Phoenix backend builds WebAssembly NIF libraries in Firecracker VMs,
relays encrypted live sessions, and provides the restricted TCP relay.
It does not run project applications.

See [backend setup](../docs/backend.md#developing) for Postgres,
Firecracker, and build prerequisites. From `backend/`:

```sh
DOCKER="sudo -n docker" mix setup
mix test                    # excludes VM tests
mix test --only vm           # requires Firecracker and /dev/kvm
mix phx.server
```

Deploy with `docker-compose.yml` and an `.env` based on `.env.example`.
See [deployment instructions](../docs/backend.md#deploying).
