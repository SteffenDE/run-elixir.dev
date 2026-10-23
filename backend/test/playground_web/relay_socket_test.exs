defmodule PlaygroundWeb.RelaySocketTest do
  # The relay's settings are the application's.
  use ExUnit.Case, async: false

  alias Playground.Test.ClientHello
  alias PlaygroundWeb.RelaySocket

  @open 1
  @opened 2
  @error 3
  @data 4
  @end_ 5
  @close 6
  @ack 7

  setup do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listen)
    previous = Application.get_env(:playground, Playground.Relay)

    Application.put_env(:playground, Playground.Relay,
      hosts: ["localhost"],
      port: port,
      allow_reserved: true,
      window: 4096,
      max_connections: 2
    )

    on_exit(fn ->
      if previous,
        do: Application.put_env(:playground, Playground.Relay, previous),
        else: Application.delete_env(:playground, Playground.Relay)
    end)

    {:ok, state} = RelaySocket.connect(%{})
    %{listen: listen, port: port, state: state, hello: ClientHello.capture("localhost")}
  end

  defp frame(kind, id, payload \\ ""), do: IO.iodata_to_binary([kind, <<id::32>>, payload])
  defp send_in(state, frame), do: RelaySocket.handle_in({frame, opcode: :binary}, state)

  # The socket's answer to the next thing a connection tells it.
  defp next(state) do
    assert_receive {:relay, _id, _event} = message, 2_000
    {:push, {:binary, frame}, state} = RelaySocket.handle_info(message, state)
    {IO.iodata_to_binary(frame), state}
  end

  defp open(state, id, port, host \\ "localhost") do
    {:ok, state} = send_in(state, frame(@open, id, <<port::16, host::binary>>))
    state
  end

  defp opened(%{listen: listen, port: port, state: state}, id) do
    state = open(state, id, port)
    {:ok, upstream} = :gen_tcp.accept(listen, 2_000)
    {opened, state} = next(state)
    assert opened == frame(@opened, id)
    {state, upstream}
  end

  test "a ClientHello naming the host, then bytes both ways", context do
    {state, upstream} = opened(context, 1)

    {:ok, state} = send_in(state, frame(@data, 1, context.hello))
    assert {:ok, received} = :gen_tcp.recv(upstream, byte_size(context.hello), 2_000)
    assert received == context.hello
    {ack, state} = next(state)
    assert ack == frame(@ack, 1, <<byte_size(context.hello)::32>>)

    {:ok, state} = send_in(state, frame(@data, 1, "more"))
    assert {:ok, "more"} = :gen_tcp.recv(upstream, 4, 2_000)
    {_ack, state} = next(state)

    :ok = :gen_tcp.send(upstream, "answer")
    {data, state} = next(state)
    assert data == frame(@data, 1, "answer")
    {:ok, state} = send_in(state, frame(@ack, 1, <<6::32>>))

    {:ok, state} = send_in(state, frame(@end_, 1))
    assert {:error, :closed} = :gen_tcp.recv(upstream, 0, 2_000)
    :gen_tcp.close(upstream)
    {ended, state} = next(state)
    assert ended == frame(@end_, 1)
    assert state.connections == %{}
  end

  test "hosts not listed, and other ports, are refused", %{state: state, port: port} do
    assert {:reply, :ok, {:binary, refused}, _state} =
             send_in(state, frame(@open, 1, <<port::16, "example.com">>))

    assert IO.iodata_to_binary(refused) == frame(@error, 1, "not_allowed")

    assert {:reply, :ok, {:binary, refused}, _state} =
             send_in(state, frame(@open, 2, <<port + 1::16, "localhost">>))

    assert IO.iodata_to_binary(refused) == frame(@error, 2, "not_allowed")
  end

  test "plain text never reaches the host", context do
    {state, upstream} = opened(context, 1)
    {:ok, state} = send_in(state, frame(@data, 1, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"))
    {refused, state} = next(state)
    assert refused == frame(@error, 1, "not_tls")
    assert {:error, :closed} = :gen_tcp.recv(upstream, 0, 2_000)
    assert state.connections == %{}
  end

  test "a ClientHello naming another host never reaches it", context do
    {state, upstream} = opened(context, 1)
    {:ok, state} = send_in(state, frame(@data, 1, ClientHello.capture("evil.example")))
    {refused, _state} = next(state)
    assert refused == frame(@error, 1, "server_name")
    assert {:error, :closed} = :gen_tcp.recv(upstream, 0, 2_000)
  end

  test "the hello may come in pieces", context do
    {state, upstream} = opened(context, 1)
    <<first::binary-size(10), rest::binary>> = context.hello
    {:ok, state} = send_in(state, frame(@data, 1, first))
    {:ok, state} = send_in(state, frame(@data, 1, rest))
    assert {:ok, received} = :gen_tcp.recv(upstream, byte_size(context.hello), 2_000)
    assert received == context.hello
    {ack, _state} = next(state)
    assert ack == frame(@ack, 1, <<byte_size(context.hello)::32>>)
  end

  test "a page that sends past its window loses the connection", context do
    {state, _upstream} = opened(context, 1)
    {:ok, state} = send_in(state, frame(@data, 1, :binary.copy("x", 4000)))

    assert {:reply, :ok, {:binary, refused}, state} =
             send_in(state, frame(@data, 1, :binary.copy("x", 200)))

    assert IO.iodata_to_binary(refused) == frame(@error, 1, "window")
    assert state.connections == %{}
  end

  test "the host's bytes wait for the page's acknowledgements", context do
    {state, upstream} = opened(context, 1)
    {:ok, state} = send_in(state, frame(@data, 1, context.hello))
    {_ack, state} = next(state)

    :ok = :gen_tcp.send(upstream, :binary.copy("y", 64 * 1024))
    {received, state} = drain(state, 0)
    assert received >= 4096 and received < 64 * 1024

    {:ok, state} = send_in(state, frame(@ack, 1, <<received::32>>))
    {more, _state} = drain(state, 0)
    assert more > 0
  end

  defp drain(state, total) do
    receive do
      {:relay, 1, {:data, bytes}} = message ->
        {:push, _frame, state} = RelaySocket.handle_info(message, state)
        drain(state, total + byte_size(bytes))
    after
      300 -> {total, state}
    end
  end

  test "at most :max_connections at once", %{state: state, port: port} = context do
    state = open(state, 1, port)
    state = open(state, 2, port)

    assert {:reply, :ok, {:binary, refused}, _state} =
             send_in(state, frame(@open, 3, <<port::16, "localhost">>))

    assert IO.iodata_to_binary(refused) == frame(@error, 3, "too_many_connections")
    :gen_tcp.close(context.listen)
  end

  test "closing a connection closes the host's", context do
    {state, upstream} = opened(context, 1)
    {:ok, state} = send_in(state, frame(@close, 1))
    assert state.connections == %{}
    assert {:error, :closed} = :gen_tcp.recv(upstream, 0, 2_000)
  end

  test "frames too large or malformed end the socket", context do
    {state, _upstream} = opened(context, 1)
    too_large = :binary.copy("x", 65_537)
    assert {:stop, :bad_payload, _} = send_in(state, frame(@data, 1, too_large))
    assert {:stop, :bad_frame, _} = send_in(state, <<99, 1>>)
    assert {:stop, :binary_only, _} = RelaySocket.handle_in({"hi", opcode: :text}, state)
  end

  test "origins: the configured hosts, any while unset" do
    assert RelaySocket.origin_allowed?(URI.parse("https://example.com"))

    Application.put_env(:playground, :relay_origins, ["*.run-elixir-usercontent.org"])
    on_exit(fn -> Application.delete_env(:playground, :relay_origins) end)

    assert RelaySocket.origin_allowed?(URI.parse("https://p-abc.run-elixir-usercontent.org"))
    refute RelaySocket.origin_allowed?(URI.parse("https://run-elixir.dev"))
    refute RelaySocket.origin_allowed?(URI.parse("https://evil.example"))
  end
end
