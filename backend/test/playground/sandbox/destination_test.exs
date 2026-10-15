defmodule Playground.Sandbox.DestinationTest do
  use ExUnit.Case, async: true

  alias Playground.Sandbox.Destination

  doctest Destination

  test "denies reserved addresses" do
    for address <- [
          "0.0.0.0",
          "10.1.2.3",
          "100.64.0.1",
          "127.0.0.1",
          "169.254.169.254",
          "172.31.255.255",
          "192.168.1.1",
          "224.0.0.1",
          "255.255.255.255",
          "::1",
          "::ffff:127.0.0.1",
          "fc00::1",
          "fe80::1",
          "fe80:0:0:1::1",
          "ff02::1"
        ] do
      assert Destination.resolve(address) == {:error, :reserved_address}, address
    end
  end

  test "allows public addresses" do
    assert Destination.resolve("1.1.1.1") == {:ok, [{1, 1, 1, 1}]}
    assert Destination.resolve("172.32.0.1") == {:ok, [{172, 32, 0, 1}]}

    assert Destination.resolve("2606:4700:4700::1111") ==
             {:ok, [{9734, 18176, 18176, 0, 0, 0, 0, 4369}]}
  end

  test "denies names that resolve to reserved addresses" do
    assert Destination.resolve("localhost") == {:error, :reserved_address}
    assert {:ok, [_ | _]} = Destination.resolve("localhost", allow_reserved: true)
  end
end
