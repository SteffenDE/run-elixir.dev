defmodule Playground.Relay.Connection do
  @moduledoc """
  One connection through the relay: a TCP connection to a listed host, for
  the socket that opened it (its owner, `PlaygroundWeb.RelaySocket`).

  It tells its owner `{:relay, id, event}`: `:opened`, `{:data, bytes}` from
  the host, `{:written, n}` once n of the page's bytes went to the host,
  `:end` when the host closed, `{:error, reason}`. It ends after either of
  the last two, when its owner goes, or after `:idle_timeout` without bytes.

  The page's bytes go on only once they start with a ClientHello naming the
  host. The host's are read while the page has acknowledged all but
  `:window` of them.
  """

  use GenServer, restart: :temporary

  alias Playground.Relay
  alias Playground.Relay.ClientHello

  @max_hello ClientHello.max_size()

  def start_link({owner, id, host, port}),
    do: GenServer.start_link(__MODULE__, {owner, id, host, port})

  @doc "The page's bytes, for the host."
  def data(pid, bytes), do: GenServer.cast(pid, {:data, bytes})

  @doc "The page will send no more (the host may still)."
  def finish(pid), do: GenServer.cast(pid, :end)

  @doc "The page read `n` more of the host's bytes."
  def ack(pid, n), do: GenServer.cast(pid, {:ack, n})

  @impl true
  def init({owner, id, host, port}) do
    Process.monitor(owner)

    state = %{
      owner: owner,
      id: id,
      host: host,
      port: port,
      socket: nil,
      # The page's first bytes until they name the host, then :checked.
      hello: <<>>,
      unacked: 0,
      reading?: false,
      carried: 0
    }

    {:ok, state, {:continue, :connect}}
  end

  @impl true
  def handle_continue(:connect, state) do
    with {:ok, addresses} <- Relay.resolve(state.host),
         {:ok, socket} <- connect(addresses, state.port, Relay.config(:connect_timeout)) do
      tell(state, :opened)
      {:noreply, read(%{state | socket: socket}), idle()}
    else
      {:error, reason} -> fail(state, reason)
    end
  end

  @impl true
  def handle_cast({:data, bytes}, %{hello: :checked} = state) do
    with {:ok, state} <- count(state, bytes),
         :ok <- :gen_tcp.send(state.socket, bytes) do
      tell(state, {:written, byte_size(bytes)})
      {:noreply, state, idle()}
    else
      {:error, reason} -> fail(state, reason)
    end
  end

  def handle_cast({:data, bytes}, state) do
    hello = state.hello <> bytes

    case ClientHello.server_name(hello) do
      :more when byte_size(hello) < @max_hello ->
        {:noreply, %{state | hello: hello}, idle()}

      {:ok, name} ->
        if same_host?(name, state.host),
          do: handle_cast({:data, hello}, %{state | hello: :checked}),
          else: fail(state, :server_name)

      _ ->
        fail(state, :not_tls)
    end
  end

  def handle_cast(:end, state) do
    if state.socket, do: :gen_tcp.shutdown(state.socket, :write)
    {:noreply, state, idle()}
  end

  def handle_cast({:ack, n}, state) do
    {:noreply, read(%{state | unacked: max(state.unacked - n, 0)}), idle()}
  end

  @impl true
  def handle_info({:tcp, socket, bytes}, %{socket: socket} = state) do
    case count(state, bytes) do
      {:ok, state} ->
        tell(state, {:data, bytes})
        state = %{state | unacked: state.unacked + byte_size(bytes), reading?: false}
        {:noreply, read(state), idle()}

      {:error, reason} ->
        fail(state, reason)
    end
  end

  def handle_info({:tcp_closed, socket}, %{socket: socket} = state) do
    tell(state, :end)
    {:stop, :normal, state}
  end

  def handle_info({:tcp_error, socket, reason}, %{socket: socket} = state),
    do: fail(state, reason)

  def handle_info({:DOWN, _ref, :process, owner, _reason}, %{owner: owner} = state),
    do: {:stop, :normal, state}

  def handle_info(:timeout, state), do: fail(state, :idle)

  # Reads on while the page has room for more.
  defp read(%{reading?: false, socket: socket} = state) when socket != nil do
    if state.unacked < Relay.config(:window) do
      :ok = :inet.setopts(socket, active: :once)
      %{state | reading?: true}
    else
      state
    end
  end

  defp read(state), do: state

  defp count(state, bytes) do
    carried = state.carried + byte_size(bytes)

    if carried > Relay.config(:max_bytes),
      do: {:error, :too_large},
      else: {:ok, %{state | carried: carried}}
  end

  defp connect([], _port, _timeout), do: {:error, :unreachable}

  defp connect([address | rest], port, timeout) do
    options = [:binary, active: false, nodelay: true, send_timeout: 30_000]

    case :gen_tcp.connect(address, port, options, timeout) do
      {:ok, socket} -> {:ok, socket}
      {:error, _reason} when rest != [] -> connect(rest, port, timeout)
      {:error, reason} -> {:error, reason}
    end
  end

  defp same_host?(name, host),
    do: String.downcase(String.trim_trailing(name, ".")) == String.downcase(host)

  defp fail(state, reason) do
    tell(state, {:error, reason})
    {:stop, :normal, state}
  end

  defp tell(state, event), do: send(state.owner, {:relay, state.id, event})

  defp idle, do: Relay.config(:idle_timeout)
end
