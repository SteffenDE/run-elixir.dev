defmodule Playground.Nif.Recipe do
  @moduledoc """
  How a template builds: a shell script, run in a sandbox VM with `sh -eu`
  in the package's unpacked sources, as `make` would run in its directory.

    * `"script"` - the script. Its environment is elixir_make's, as far as
      Makefiles use it, for the erl_nif layer (as in nif/build.py):
      `CC=/tools/nifcc`, `CXX=/tools/nifc++`, `CFLAGS=-O2`, `CXXFLAGS=-O2`,
      `ERTS_INCLUDE_DIR=/nif/include`, `MIX_APP_PATH=$APP`, `MIX_ENV=prod`,
      `MIX_TARGET=host`, `CROSSCOMPILE=wasm32-wasip1`; and `SRC` (the
      sources), `APP` (the app directory, whose `priv` is the result),
      `PKG_NAME` and `PKG_VERSION`. wasi-sdk is at `/opt/wasi-sdk`, its
      CMake toolchain at `/opt/wasi-sdk/share/cmake/wasi-sdk-p1.cmake`. A
      build that needs its dependencies' sources (Fine's headers, say) runs
      `mix deps.get`, with Hex's hosts allowed.
    * `"allowed_hosts"` - the hosts the build may connect to (names, or
      `*.domain`), from those `Playground.Nif.allowed_hosts/0` permits. None:
      no network.
    * `"timeout_minutes"` - 1 to 30, 10 by default.

  """

  @enforce_keys [:script]
  defstruct script: nil, allowed_hosts: [], timeout_minutes: 10

  @type t :: %__MODULE__{
          script: String.t(),
          allowed_hosts: [String.t()],
          timeout_minutes: pos_integer()
        }

  @max_script 65_536

  @doc """
  Validates a recipe given as a map with string keys.
  """
  @spec new(map()) :: {:ok, t()} | {:error, String.t()}
  def new(%{} = map) do
    map = Map.new(map, fn {key, value} -> {to_string(key), value} end)

    with {:ok, script} <- script(map["script"]),
         {:ok, hosts} <- hosts(Map.get(map, "allowed_hosts") || []),
         {:ok, timeout} <- timeout(Map.get(map, "timeout_minutes") || 10),
         [] <- Map.keys(map) -- ~w(script allowed_hosts timeout_minutes) do
      {:ok, %__MODULE__{script: script, allowed_hosts: hosts, timeout_minutes: timeout}}
    else
      {:error, reason} -> {:error, reason}
      unknown when is_list(unknown) -> {:error, "unknown keys: #{Enum.join(unknown, ", ")}"}
    end
  end

  def new(_other), do: {:error, "must be an object"}

  @doc """
  The recipe as a map with string keys, as templates store it.
  """
  def dump(%__MODULE__{} = recipe) do
    %{
      "script" => recipe.script,
      "allowed_hosts" => recipe.allowed_hosts,
      "timeout_minutes" => recipe.timeout_minutes
    }
  end

  defp script(script) when is_binary(script) and byte_size(script) in 1..@max_script,
    do: {:ok, script}

  defp script(_other), do: {:error, "script must be a non-empty string of at most 64 KiB"}

  defp hosts(hosts) when is_list(hosts) do
    permitted = Playground.Nif.allowed_hosts()

    case Enum.reject(hosts, &permitted?(&1, permitted)) do
      [] -> {:ok, Enum.uniq(hosts)}
      denied -> {:error, "hosts not permitted: #{Enum.join(denied, ", ")}"}
    end
  end

  defp hosts(_other), do: {:error, "allowed_hosts must be a list"}

  # A name the permitted list allows, or a *.domain within one it has.
  defp permitted?("*." <> domain, permitted) when is_binary(domain),
    do: ("*." <> domain) in permitted

  defp permitted?(host, permitted) when is_binary(host),
    do: Playground.Sandbox.Destination.allowed?(host, permitted)

  defp permitted?(_other, _permitted), do: false

  defp timeout(minutes) when is_integer(minutes) and minutes in 1..30, do: {:ok, minutes}
  defp timeout(_other), do: {:error, "timeout_minutes must be 1 to 30"}
end
