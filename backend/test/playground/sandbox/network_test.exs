defmodule Playground.Sandbox.NetworkTest do
  use ExUnit.Case, async: true

  alias Playground.Sandbox.Blocked
  alias Playground.Sandbox.Connection
  alias Playground.Sandbox.Network

  # 127.0.0.1 and localhost are reserved, so the relay's own tests allow them.
  @local [allow_reserved: true, allowed_hosts: ["127.0.0.1", "localhost"]]

  test "relays a connection and records it" do
    port = server(fn socket -> :gen_tcp.send(socket, "reply:" <> recv_all(socket)) end)
    {network, path} = start_network(@local)

    guest = guest(path, "SANDBOX_CONNECT 127.0.0.1 #{port} plain -\nhello")
    :ok = :gen_tcp.shutdown(guest, :write)

    assert recv_all(guest) == "reply:hello"

    assert %{connections: [connection]} = Network.report(network)

    assert %Connection{host: "127.0.0.1", port: ^port, sent: 5, received: 11, error: nil} =
             connection
  end

  test "denies hosts that aren't allowed, and TLS server names that aren't" do
    {network, path} = start_network(allow_reserved: true, allowed_hosts: ["localhost"])

    for header <- [
          "SANDBOX_CONNECT 127.0.0.1 80 plain -\n",
          "SANDBOX_CONNECT localhost 443 tls evil.example\n"
        ] do
      assert recv_all(guest(path, header)) == ""
    end

    assert [
             %Connection{host: "127.0.0.1", error: :not_allowed},
             %Connection{host: "localhost", server_name: "evil.example", error: :not_allowed}
           ] = Enum.sort_by(Network.report(network).connections, & &1.host)
  end

  test "denies destinations that aren't public" do
    {network, path} = start_network(allowed_hosts: ["127.0.0.1", "localhost"])

    for host <- ["127.0.0.1", "localhost"] do
      guest = guest(path, "SANDBOX_CONNECT #{host} 80 plain -\n")
      assert recv_all(guest) == ""
    end

    assert [
             %Connection{host: "127.0.0.1", error: :reserved_address},
             %Connection{host: "localhost", error: :reserved_address}
           ] = Enum.sort_by(Network.report(network).connections, & &1.host)
  end

  test "records destinations that can't be reached" do
    {:ok, listener} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(listener)
    :gen_tcp.close(listener)

    {network, path} = start_network(@local)
    guest = guest(path, "SANDBOX_CONNECT 127.0.0.1 #{port} plain -\n")

    assert recv_all(guest) == ""
    assert %{connections: [%Connection{error: :econnrefused}]} = Network.report(network)
  end

  test "records invalid headers" do
    {network, path} = start_network([])
    guest = guest(path, "GET / HTTP/1.1\r\n")

    assert recv_all(guest) == ""

    assert %{connections: [%Connection{host: nil, port: nil, error: :invalid_header}]} =
             Network.report(network)
  end

  test "records lookups and blocked traffic" do
    {network, path} = start_network([])

    for event <- ["SANDBOX_EVENT dns hex.pm\n", "SANDBOX_EVENT blocked udp 1.1.1.1 123\n"] do
      assert recv_all(guest(path, event)) == ""
    end

    assert Network.report(network) == %{
             connections: [],
             lookups: ["hex.pm"],
             blocked: [%Blocked{protocol: :udp, host: "1.1.1.1", port: 123}]
           }
  end

  test "ends connections that are still open when reporting" do
    port = server(fn socket -> recv_all(socket) end)
    {network, path} = start_network(@local)

    guest = guest(path, "SANDBOX_CONNECT 127.0.0.1 #{port} plain -\nstill talking")
    Process.sleep(100)

    assert %{connections: [%Connection{sent: 13, error: nil}]} = Network.report(network)
    assert recv_all(guest) == ""
  end

  defp start_network(opts) do
    path =
      Path.join(System.tmp_dir!(), "sandbox-network-test-#{System.unique_integer([:positive])}")

    network = start_supervised!({Network, [path: path] ++ opts})
    {network, path}
  end

  defp guest(path, data) do
    {:ok, guest} =
      :gen_tcp.connect({:local, String.to_charlist(path)}, 0, [:binary, active: false])

    :ok = :gen_tcp.send(guest, data)
    guest
  end

  defp server(handle) do
    listen_opts = [:binary, ip: {127, 0, 0, 1}, active: false, exit_on_close: false]
    {:ok, listener} = :gen_tcp.listen(0, listen_opts)
    {:ok, port} = :inet.port(listener)

    start_supervised!(
      {Task,
       fn ->
         {:ok, socket} = :gen_tcp.accept(listener)
         handle.(socket)
         :gen_tcp.close(socket)
       end}
    )

    port
  end

  defp recv_all(socket, acc \\ "") do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, data} -> recv_all(socket, acc <> data)
      {:error, :closed} -> acc
    end
  end
end
