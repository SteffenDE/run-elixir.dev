defmodule Playground.Sandbox.Connection do
  @moduledoc """
  A TCP connection a job opened.

  `host` is the name the job looked up, or the address it connected to without
  looking one up. `tls?` says whether the connection started with a TLS
  handshake, and `server_name` is the name the job asked for in it, which isn't
  necessarily `host`.

  `sent` counts the bytes the job sent and `received` the bytes it got back.

  `error` says why the connection couldn't be made or ended abnormally, for
  example `:not_allowed` when the host isn't in the job's allowed hosts, or
  `:reserved_address` when the destination isn't a public address.
  """

  @enforce_keys [:host, :port, :tls?, :server_name, :sent, :received, :duration_ms, :error]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          host: String.t() | nil,
          port: :inet.port_number() | nil,
          tls?: boolean(),
          server_name: String.t() | nil,
          sent: non_neg_integer(),
          received: non_neg_integer(),
          duration_ms: non_neg_integer(),
          error: term() | nil
        }
end
