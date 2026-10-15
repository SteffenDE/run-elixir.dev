# Tests that boot VMs (and build their artifacts with Docker when there are
# none) run with: mix test --only vm
ExUnit.start(exclude: [:docker, :vm])
Ecto.Adapters.SQL.Sandbox.mode(Playground.Repo, :manual)
