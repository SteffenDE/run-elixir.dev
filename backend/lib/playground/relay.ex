defmodule Playground.Relay do
  @moduledoc """
  The TCP relay (docs/relay.md): the page's TLS connections to a few hosts
  that send no CORS headers, carried over one WebSocket (`/relay`,
  `PlaygroundWeb.RelaySocket`) as raw bytes. The page does TLS itself; the
  relay sees the host, the port and how many bytes pass, never what they say.

  A connection is let through only to a listed host (`priv/relay/hosts.json`,
  which the page reads too), on port 443, at a public address the relay
  resolved itself, and once its first bytes are a ClientHello naming that
  host (`Playground.Relay.ClientHello`).

  Limits, `config :playground, Playground.Relay`:

    * `:max_connections` - open at once over one socket
    * `:max_total` - open at once over all sockets
    * `:connect_timeout` - to connect to the host, in ms
    * `:idle_timeout` - a connection with no bytes either way ends, in ms
    * `:window` - bytes either side may have sent the other unacknowledged
    * `:max_payload` - the most bytes one frame may carry
    * `:max_bytes` - the most bytes one connection may carry, both ways
    * `:hosts`, `:port`, `:allow_reserved` - the list and port (from
      hosts.json), and reserved addresses (tests only)

  """

  alias Playground.Sandbox.Destination

  @hosts_file Path.expand("../../priv/relay/hosts.json", __DIR__)
  @external_resource @hosts_file
  @list @hosts_file |> File.read!() |> JSON.decode!()

  @defaults [
    max_connections: 16,
    max_total: 512,
    connect_timeout: 10_000,
    idle_timeout: 300_000,
    window: 262_144,
    max_payload: 65_536,
    max_bytes: 1_073_741_824,
    hosts: @list["hosts"],
    port: @list["port"],
    allow_reserved: false
  ]

  @doc "A limit or setting (see the moduledoc)."
  def config(key),
    do: Keyword.get(Application.get_env(:playground, __MODULE__, []), key, @defaults[key])

  @doc """
  Whether the relay connects to `host` on `port`.

      iex> Playground.Relay.allowed?("codeload.github.com", 443)
      true
      iex> Playground.Relay.allowed?("github.com", 22)
      false
      iex> Playground.Relay.allowed?("example.com", 443)
      false

  """
  def allowed?(host, port),
    do: port == config(:port) and Destination.allowed?(host, config(:hosts))

  @doc "The host's addresses to connect to: public ones only, unless allowed for tests."
  def resolve(host), do: Destination.resolve(host, allow_reserved: config(:allow_reserved))
end
