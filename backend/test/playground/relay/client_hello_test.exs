defmodule Playground.Relay.ClientHelloTest do
  use ExUnit.Case, async: true

  alias Playground.Relay.ClientHello
  alias Playground.Test.ClientHello, as: Capture

  doctest ClientHello

  test "reads the server name of OTP's ClientHello" do
    hello = Capture.capture("github.com")
    assert ClientHello.server_name(hello) == {:ok, "github.com"}
  end

  test "waits for the whole first record" do
    hello = Capture.capture("api.anthropic.com")

    for size <- [1, 2, 4, 5, 6, 100, byte_size(hello) - 1] do
      assert ClientHello.server_name(binary_part(hello, 0, size)) == :more
    end
  end

  test "refuses what is not a ClientHello naming a server" do
    assert ClientHello.server_name("GET / HTTP/1.1\r\nHost: github.com\r\n\r\n") == :error
    assert ClientHello.server_name(<<0x17, 3, 3, 0, 1, 0>>) == :error
    # A handshake record whose message is not a ClientHello.
    assert ClientHello.server_name(<<22, 3, 3, 0, 4, 2, 0, 0, 0>>) == :error
    # A fragment longer than a record may be.
    assert ClientHello.server_name(<<22, 3, 3, 0x40, 1>>) == :error
  end
end
