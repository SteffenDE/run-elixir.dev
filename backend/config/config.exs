# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :playground,
  ecto_repos: [Playground.Repo],
  generators: [timestamp_type: :utc_datetime]

# Builds boot a VM each, and setups run an LLM that boots VMs too, so both
# run one at a time.
config :playground, Oban,
  engine: Oban.Engines.Basic,
  notifier: Oban.Notifiers.PG,
  queues: [builds: 1, setups: 1, notifications: 5],
  lifeline: [rescue_after: {2, :hours}],
  pruner: [max_age: {7, :days}],
  repo: Playground.Repo

# Failed builds and new templates are notified, see Playground.Notifications.
config :playground, Playground.Notifications, backends: [Playground.Notifications.WebPush]

# The agent that writes templates, see Playground.Nif.Agent. The API key is
# set in runtime.exs.
config :playground, Playground.Nif.Agent,
  model: "openai:gpt-6-luna",
  reasoning_effort: "high",
  budget_usd: 2.0

# See Playground.Nif. Packages with fewer downloads than this get no agent
# session unless an admin requests their build.
config :playground, Playground.Nif, daily_budget_usd: 20.0, setup_min_downloads: 10_000

# Live sessions' relay, see Playground.Live: participants per session,
# how long a host may be away (a reload), a session's longest life, the
# largest message, and what each participant may send a second (four
# seconds' worth at once).
config :playground, Playground.Live,
  max_participants: 16,
  grace_ms: 30_000,
  lifetime_ms: :timer.hours(24),
  max_message: 262_144,
  rate: [bytes: 1_048_576, messages: 200]

# Configure the endpoint
config :playground, PlaygroundWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: PlaygroundWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Playground.PubSub,
  live_view: [signing_salt: "fjRbE7F7"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
