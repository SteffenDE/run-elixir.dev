defmodule Playground.Sandbox.Network do
  @moduledoc false

  # Relays the TCP connections of one VM.
  #
  # sandbox-netd hands every connection the guest opens to the socket at :path,
  # introduced by a "SANDBOX_CONNECT <host> <port> <tls|plain> <server name>" line.
  # Each is relayed by its own process, which checks the destination, connects to
  # it and records what it carried as a Playground.Sandbox.Connection.
  #
  # A destination must be allowed (Destination.allowed?/2): its host, and the
  # server name a TLS client asked for, which TLS then holds the server to.
  #
  # Lookups and blocked traffic are reported to the same socket, as a connection
  # carrying nothing but a "SANDBOX_EVENT dns <name>" or
  # "SANDBOX_EVENT blocked udp <host> <port>" line.

  use GenServer

  alias Playground.Sandbox.Blocked
  alias Playground.Sandbox.Connection
  alias Playground.Sandbox.Destination

  @header_timeout 5_000
  @connect_timeout 15_000
  @max_header 512

  # How long a report waits for relays that can't stop right away, for example
  # while they're still connecting.
  @settle_timeout 2_000

  @doc """
  Starts listening at `:path`.

  Options:

    * `:allowed_hosts` - the names connections may go to, see
      `Playground.Sandbox.Destination.allowed?/2`
    * `:allow_reserved` - passed on to `Playground.Sandbox.Destination.resolve/2`

  """
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc """
  Stops accepting connections, ends those still open and returns all records.
  """
  @spec report(pid()) :: %{
          connections: [Connection.t()],
          lookups: [String.t()],
          blocked: [Blocked.t()]
        }
  def report(network), do: GenServer.call(network, :report, 2 * @settle_timeout)

  @impl true
  def init(opts) do
    # Relays are linked, so they end with the network.
    Process.flag(:trap_exit, true)

    path = Keyword.fetch!(opts, :path)
    File.rm(path)

    socket_opts = [
      :binary,
      ifaddr: {:local, String.to_charlist(path)},
      active: false,
      exit_on_close: false
    ]

    case :gen_tcp.listen(0, socket_opts) do
      {:ok, listener} ->
        network = self()
        spawn_link(fn -> accept(network, listener) end)

        {:ok,
         %{
           listener: listener,
           path: path,
           relay_opts: Keyword.take(opts, [:allowed_hosts, :allow_reserved]),
           relays: %{},
           records: %{connections: [], lookups: [], blocked: []},
           closed?: false,
           waiting: nil
         }}

      {:error, reason} ->
        {:stop, {:listen, path, reason}}
    end
  end

  @impl true
  def handle_call(:relay, _from, %{closed?: true} = state), do: {:reply, :error, state}

  def handle_call(:relay, _from, state) do
    network = self()
    relay_opts = state.relay_opts

    relay =
      spawn_link(fn ->
        receive do
          {:socket, guest} -> relay(network, guest, relay_opts)
        end
      end)

    {:reply, {:ok, relay}, %{state | relays: Map.put(state.relays, relay, true)}}
  end

  def handle_call(:report, from, state) do
    :gen_tcp.close(state.listener)
    Enum.each(Map.keys(state.relays), &send(&1, :stop))
    Process.send_after(self(), :settled, @settle_timeout)

    maybe_reply(%{state | closed?: true, waiting: from})
  end

  @impl true
  def handle_info({:record, kind, record}, state) do
    {:noreply, update_in(state.records[kind], &[record | &1])}
  end

  # A relay sends its record before it exits, so the record is always there by
  # the time its exit arrives.
  def handle_info({:EXIT, pid, _reason}, state) do
    maybe_reply(%{state | relays: Map.delete(state.relays, pid)})
  end

  def handle_info(:settled, %{waiting: nil} = state), do: {:noreply, state}

  def handle_info(:settled, state) do
    Enum.each(Map.keys(state.relays), &Process.exit(&1, :kill))
    maybe_reply(%{state | relays: %{}})
  end

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.listener)
    File.rm(state.path)
  end

  defp maybe_reply(%{waiting: from, relays: relays} = state)
       when from != nil and map_size(relays) == 0 do
    records = Map.new(state.records, fn {kind, list} -> {kind, Enum.reverse(list)} end)
    GenServer.reply(from, records)
    {:noreply, %{state | waiting: nil}}
  end

  defp maybe_reply(state), do: {:noreply, state}

  defp accept(network, listener) do
    case :gen_tcp.accept(listener) do
      {:ok, guest} ->
        case GenServer.call(network, :relay) do
          {:ok, relay} ->
            :ok = :gen_tcp.controlling_process(guest, relay)
            send(relay, {:socket, guest})

          :error ->
            :gen_tcp.close(guest)
        end

        accept(network, listener)

      # The listener is closed by a report.
      {:error, _reason} ->
        :ok
    end
  end

  defp relay(network, guest, opts) do
    started_at = System.monotonic_time(:millisecond)

    {kind, record} =
      case read_header(guest) do
        {:event, kind, record} -> {kind, record}
        header -> {:connections, relay_connection(guest, header, opts, started_at)}
      end

    :gen_tcp.close(guest)
    send(network, {:record, kind, record})
  end

  defp relay_connection(guest, header, opts, started_at) do
    {destination, result} =
      case header do
        {:connect, destination} ->
          {destination, open(destination, opts)}

        {:error, reason} ->
          {%{host: nil, port: nil, tls?: false, server_name: nil}, {:error, reason}}
      end

    relayed =
      case result do
        {:ok, upstream} -> relay_bytes(guest, upstream)
        {:error, reason} -> %{sent: 0, received: 0, error: reason}
      end

    %Connection{
      host: destination.host,
      port: destination.port,
      tls?: destination.tls?,
      server_name: destination.server_name,
      sent: relayed.sent,
      received: relayed.received,
      duration_ms: System.monotonic_time(:millisecond) - started_at,
      error: relayed.error
    }
  end

  # Line mode only reads the header, so the first bytes the guest sent after it
  # are still in the socket.
  defp read_header(guest) do
    :inet.setopts(guest, packet: :line, packet_size: @max_header)
    result = :gen_tcp.recv(guest, 0, @header_timeout)
    :inet.setopts(guest, packet: :raw)

    case result do
      {:ok, line} -> line |> String.trim_trailing("\n") |> String.split(" ") |> parse_header()
      {:error, _reason} -> {:error, :invalid_header}
    end
  end

  defp parse_header(["SANDBOX_CONNECT", host, port, protocol, server_name])
       when protocol in ["tls", "plain"] do
    case Integer.parse(port) do
      {port, ""} when port in 1..65_535 ->
        server_name = if server_name != "-", do: server_name
        {:connect, %{host: host, port: port, tls?: protocol == "tls", server_name: server_name}}

      _other ->
        {:error, :invalid_header}
    end
  end

  defp parse_header(["SANDBOX_EVENT", "dns", name]), do: {:event, :lookups, name}

  defp parse_header(["SANDBOX_EVENT", "blocked", "udp", host, port]) do
    case Integer.parse(port) do
      {port, ""} when port in 0..65_535 ->
        {:event, :blocked, %Blocked{protocol: :udp, host: host, port: port}}

      _other ->
        {:error, :invalid_header}
    end
  end

  defp parse_header(_fields), do: {:error, :invalid_header}

  defp open(destination, opts) do
    allowed = Keyword.get(opts, :allowed_hosts, [])

    if Destination.allowed?(destination.host, allowed) and
         (destination.server_name == nil or
            Destination.allowed?(destination.server_name, allowed)) do
      connect(destination.host, destination.port, opts)
    else
      {:error, :not_allowed}
    end
  end

  defp connect(host, port, opts) do
    with {:ok, addresses} <- Destination.resolve(host, opts) do
      Enum.reduce_while(addresses, {:error, :unreachable}, fn address, _result ->
        socket_opts = [:binary, active: false, exit_on_close: false]

        case :gen_tcp.connect(address, port, socket_opts, @connect_timeout) do
          {:ok, upstream} -> {:halt, {:ok, upstream}}
          {:error, reason} -> {:cont, {:error, reason}}
        end
      end)
    end
  end

  # Both sides stay open for writing when the other stops, so that a response to
  # a request whose sender has finished still arrives.
  defp relay_bytes(guest, upstream) do
    :inet.setopts(guest, active: :once)
    :inet.setopts(upstream, active: :once)

    loop(%{guest: guest, upstream: upstream, open: 2, sent: 0, received: 0})
  end

  defp loop(%{open: 0} = relay), do: finish(relay, nil)

  defp loop(%{guest: guest, upstream: upstream} = relay) do
    receive do
      {:tcp, ^guest, data} ->
        forward(relay, guest, upstream, data, :sent)

      {:tcp, ^upstream, data} ->
        forward(relay, upstream, guest, data, :received)

      {:tcp_closed, ^guest} ->
        :gen_tcp.shutdown(upstream, :write)
        loop(%{relay | open: relay.open - 1})

      {:tcp_closed, ^upstream} ->
        :gen_tcp.shutdown(guest, :write)
        loop(%{relay | open: relay.open - 1})

      {:tcp_error, _socket, reason} ->
        finish(relay, reason)

      :stop ->
        finish(relay, nil)
    end
  end

  defp forward(relay, from, to, data, counter) do
    case :gen_tcp.send(to, data) do
      :ok ->
        :inet.setopts(from, active: :once)
        loop(Map.update!(relay, counter, &(&1 + byte_size(data))))

      {:error, reason} ->
        finish(relay, reason)
    end
  end

  defp finish(relay, error) do
    :gen_tcp.close(relay.guest)
    :gen_tcp.close(relay.upstream)
    %{sent: relay.sent, received: relay.received, error: error}
  end
end
