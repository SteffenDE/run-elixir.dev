defmodule Playground.Sandbox.Blocked do
  @moduledoc """
  Traffic a job sent that went nowhere.

  A mediated network only carries TCP connections and DNS lookups, other UDP
  datagrams are dropped. `host` is the name the job looked up, or the address it
  sent to without looking one up.
  """

  @enforce_keys [:protocol, :host, :port]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          protocol: :udp,
          host: String.t(),
          port: :inet.port_number()
        }
end
