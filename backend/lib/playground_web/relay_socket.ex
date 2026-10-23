defmodule PlaygroundWeb.RelaySocket do
  @moduledoc """
  `/relay`: the TCP relay's WebSocket (`Playground.Relay`, docs/relay.md),
  many connections over one. Each binary frame is a kind, a connection id
  the page picks (32 bits) and the kind's payload:

      page → relay                      relay → page
      1 OPEN   port::16, host           2 OPENED
      4 DATA   bytes                    3 ERROR   reason (the id is gone)
      5 END    (the page sends no more) 4 DATA    bytes
      6 CLOSE  (the id is gone)         5 END     (the host closed; the id is gone)
      7 ACK    n::32 (bytes read)       7 ACK     n::32 (bytes passed on)

  Either side sends DATA while the other has acknowledged all but
  `:window` bytes of it; a page that sends more loses the connection, as
  one that sends a frame larger than `:max_payload`, or opens more than
  `:max_connections`.
  """

  @behaviour Phoenix.Socket.Transport

  alias Playground.Relay
  alias Playground.Relay.Connection
  alias Playground.Sandbox.Destination

  @open 1
  @opened 2
  @error 3
  @data 4
  @end_ 5
  @close 6
  @ack 7

  @doc """
  Whether a page of `uri`'s origin may open the socket: one of
  `config :playground, :relay_origins`, host names or `*.domain` (every
  exec frame has an origin of its own on the usercontent domain), or any
  when unset (developing).
  """
  def origin_allowed?(%URI{host: host}) do
    case Application.get_env(:playground, :relay_origins) do
      nil -> true
      origins -> Destination.allowed?(host, origins)
    end
  end

  @impl true
  def child_spec(_opts), do: :ignore

  @impl true
  def connect(_info), do: {:ok, %{connections: %{}, max_payload: Relay.config(:max_payload)}}

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_in({frame, opcode: :binary}, state), do: frame(frame, state)
  def handle_in(_text, state), do: {:stop, :binary_only, state}

  @impl true
  def handle_info({:relay, id, event}, state) do
    case {event, state.connections} do
      {_event, %{^id => _}} -> relayed(id, event, state)
      # Closed by the page meanwhile: what the connection said is moot.
      _ -> {:ok, state}
    end
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    case Enum.find(state.connections, fn {_id, connection} -> connection.pid == pid end) do
      nil -> {:ok, state}
      {id, _connection} -> push(@error, id, "closed", forget(state, id))
    end
  end

  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok

  defp frame(<<@open, id::32, port::16, host::binary>>, state) do
    cond do
      Map.has_key?(state.connections, id) ->
        {:stop, :id_taken, state}

      map_size(state.connections) >= Relay.config(:max_connections) ->
        reply(@error, id, "too_many_connections", state)

      not (String.valid?(host) and Relay.allowed?(host, port)) ->
        reply(@error, id, "not_allowed", state)

      true ->
        case DynamicSupervisor.start_child(
               Playground.Relay.Supervisor,
               {Connection, {self(), id, host, port}}
             ) do
          {:ok, pid} ->
            Process.monitor(pid)
            connection = %{pid: pid, inflight: 0}
            {:ok, put_in(state.connections[id], connection)}

          {:error, _reason} ->
            reply(@error, id, "busy", state)
        end
    end
  end

  defp frame(<<@data, id::32, bytes::binary>>, state) do
    case state.connections do
      _ when bytes == "" ->
        {:stop, :bad_payload, state}

      _ when byte_size(bytes) > state.max_payload ->
        {:stop, :bad_payload, state}

      %{^id => connection} ->
        connection = %{connection | inflight: connection.inflight + byte_size(bytes)}

        if connection.inflight > Relay.config(:window) do
          close(connection)
          reply(@error, id, "window", forget(state, id))
        else
          Connection.data(connection.pid, bytes)
          {:ok, put_in(state.connections[id], connection)}
        end

      # Closed meanwhile.
      _ ->
        {:ok, state}
    end
  end

  defp frame(<<@end_, id::32>>, state) do
    with %{^id => connection} <- state.connections, do: Connection.finish(connection.pid)
    {:ok, state}
  end

  defp frame(<<@close, id::32>>, state) do
    with %{^id => connection} <- state.connections, do: close(connection)
    {:ok, forget(state, id)}
  end

  defp frame(<<@ack, id::32, n::32>>, state) do
    with %{^id => connection} <- state.connections, do: Connection.ack(connection.pid, n)
    {:ok, state}
  end

  defp frame(_frame, state), do: {:stop, :bad_frame, state}

  defp relayed(id, :opened, state), do: push(@opened, id, "", state)
  defp relayed(id, {:data, bytes}, state), do: push(@data, id, bytes, state)
  defp relayed(id, :end, state), do: push(@end_, id, "", forget(state, id))

  defp relayed(id, {:error, reason}, state),
    do: push(@error, id, reason(reason), forget(state, id))

  defp relayed(id, {:written, n}, state) do
    state = update_in(state.connections[id].inflight, &max(&1 - n, 0))
    push(@ack, id, <<n::32>>, state)
  end

  defp forget(state, id), do: %{state | connections: Map.delete(state.connections, id)}

  defp close(connection),
    do: DynamicSupervisor.terminate_child(Playground.Relay.Supervisor, connection.pid)

  defp push(kind, id, payload, state), do: {:push, {:binary, [kind, <<id::32>>, payload]}, state}

  defp reply(kind, id, payload, state),
    do: {:reply, :ok, {:binary, [kind, <<id::32>>, payload]}, state}

  # A POSIX name where there is one (the page passes it on as the errno).
  defp reason(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp reason(reason), do: inspect(reason)
end
