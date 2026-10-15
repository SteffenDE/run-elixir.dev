import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :playground, Playground.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "playground_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :playground, PlaygroundWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "OaAgimiKVhupiWo7ooMx7fwalunoP1+I0YESXcTatjXcTIdMeVAJyozUSV52dR/q",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

config :playground, Oban, testing: :manual
config :playground, data_dir: Path.expand("../tmp/test-data", __DIR__)
config :playground, Playground.GitHubOAuth, client_id: "id", client_secret: "secret"

config :playground, Playground.Notifications.WebPush,
  private_key: "4_-XhK1BWn-e0SeiIz91kslpdBDa55zp2csaEP1XGnQ",
  subject: "mailto:test@localhost"
