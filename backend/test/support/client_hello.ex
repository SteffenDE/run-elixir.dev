defmodule Playground.Test.ClientHello do
  @moduledoc false

  # The first bytes OTP's ssl sends to a server named `name`: a real
  # ClientHello, caught by a listener that answers nothing.
  def capture(name) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(listen)

    client =
      Task.async(fn ->
        :ssl.connect(
          ~c"localhost",
          port,
          [verify: :verify_none, server_name_indication: String.to_charlist(name)],
          1_000
        )
      end)

    {:ok, server} = :gen_tcp.accept(listen, 1_000)
    hello = receive_hello(server, <<>>)
    :gen_tcp.close(server)
    :gen_tcp.close(listen)
    Task.shutdown(client, :brutal_kill)
    hello
  end

  defp receive_hello(server, bytes) do
    {:ok, more} = :gen_tcp.recv(server, 0, 1_000)
    bytes = bytes <> more

    case Playground.Relay.ClientHello.server_name(bytes) do
      :more -> receive_hello(server, bytes)
      _ -> bytes
    end
  end
end
