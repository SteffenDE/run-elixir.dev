defmodule Playground.RelayTest do
  use ExUnit.Case, async: true

  doctest Playground.Relay

  test "the list's hosts on 443 only" do
    for host <- ~w(github.com codeload.github.com objects.githubusercontent.com gitlab.com
                   codeberg.org pushin.eu api.anthropic.com platform.claude.com) do
      assert Playground.Relay.allowed?(host, 443), host
      refute Playground.Relay.allowed?(host, 80), host
    end

    for host <- ~w(github.com.evil.example anthropic.com gitlab.example.com example.com 127.0.0.1) do
      refute Playground.Relay.allowed?(host, 443), host
    end
  end
end
