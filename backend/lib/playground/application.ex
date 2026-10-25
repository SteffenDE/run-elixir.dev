defmodule Playground.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      PlaygroundWeb.Telemetry,
      Playground.Repo,
      {DNSCluster, query: Application.get_env(:playground, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Playground.PubSub},
      {DynamicSupervisor, name: Playground.Sandbox.Supervisor, strategy: :one_for_one},
      {Registry, name: Playground.Live.Registry, keys: :unique},
      {DynamicSupervisor, name: Playground.Live.Supervisor, strategy: :one_for_one},
      {DynamicSupervisor,
       name: Playground.Relay.Supervisor,
       strategy: :one_for_one,
       max_children: Playground.Relay.config(:max_total)},
      {Oban, Application.fetch_env!(:playground, Oban)},
      # Start to serve requests, typically the last entry
      PlaygroundWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Playground.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    PlaygroundWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
