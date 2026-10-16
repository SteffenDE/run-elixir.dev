defmodule PlaygroundWeb.LiveChannelTest do
  use ExUnit.Case, async: true

  import Phoenix.ChannelTest

  alias PlaygroundWeb.{LiveChannel, LiveSocket}

  @endpoint PlaygroundWeb.Endpoint

  defp session_id, do: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

  defp enter(session, params) do
    socket(LiveSocket, nil, %{}) |> subscribe_and_join(LiveChannel, "live:" <> session, params)
  end

  defp message(from, data), do: {:binary, <<byte_size(from), from::binary, data::binary>>}
  defp to(id, data), do: {:binary, <<byte_size(id), id::binary, data::binary>>}

  # A channel's own process, to watch it end.
  defp watch(socket), do: Process.monitor(socket.channel_pid)

  setup do
    session = session_id()
    {:ok, host, host_socket} = enter(session, %{"role" => "host"})
    %{session: session, host: host, host_socket: host_socket}
  end

  test "the host creates the session and gets a token", %{host: host} do
    assert %{id: id, host: id, admitted: true, token: token, participants: []} = host
    assert is_binary(token) and byte_size(token) == 43
  end

  test "ids must be 128 bits of base64url" do
    assert {:error, %{reason: "bad_id"}} = enter("short", %{"role" => "host"})
  end

  test "guests join sessions that exist; a second host needs the token", %{session: session} do
    assert {:error, %{reason: "no_session"}} = enter(session_id(), %{"role" => "guest"})
    assert {:error, %{reason: "taken"}} = enter(session, %{"role" => "host"})
    assert {:error, %{reason: "taken"}} = enter(session, %{"role" => "host", "token" => "nope"})
  end

  test "messages go to the others, stamped with who sent them", context do
    %{session: session, host: host, host_socket: host_socket} = context
    {:ok, guest, guest_socket} = enter(session, %{"role" => "guest"})
    assert %{admitted: true, host: host_id, host_present: true} = guest
    assert host_id == host.id
    assert_push "joined", %{id: guest_id, admitted: true}
    assert guest_id == guest.id

    ref = push(guest_socket, "b", {:binary, "hello"})
    assert_reply ref, :ok
    assert_push "m", message
    assert message == message(guest.id, "hello")

    ref = push(host_socket, "s", to(guest.id, "just you"))
    assert_reply ref, :ok
    assert_push "m", message
    assert message == message(host.id, "just you")

    ref = push(guest_socket, "s", to("nobody", "x"))
    assert_reply ref, :error, %{reason: "unknown"}
  end

  test "with admission on, a guest reaches only the host until admitted", context do
    %{session: session, host_socket: host_socket} = context
    ref = push(host_socket, "admission", %{"on" => true})
    assert_reply ref, :ok

    {:ok, other, _} = enter(session, %{"role" => "guest"})
    assert_push "joined", %{admitted: false}

    {:ok, waiting, waiting_socket} = enter(session, %{"role" => "guest"})
    assert %{admitted: false, participants: []} = waiting

    ref = push(waiting_socket, "b", {:binary, "x"})
    assert_reply ref, :error, %{reason: "not_admitted"}
    ref = push(waiting_socket, "s", to(other.id, "x"))
    assert_reply ref, :error, %{reason: "not_admitted"}
    ref = push(waiting_socket, "s", to(waiting.host, "knock"))
    assert_reply ref, :ok

    ref = push(host_socket, "admit", %{"id" => waiting.id})
    assert_reply ref, :ok
    assert_push "admitted", %{id: id}
    assert id == waiting.id
    ref = push(waiting_socket, "b", {:binary, "in"})
    assert_reply ref, :ok
  end

  test "only the host commands", %{session: session, host_socket: host_socket} do
    {:ok, guest, guest_socket} = enter(session, %{"role" => "guest"})
    ref = push(guest_socket, "kick", %{"id" => guest.id})
    assert_reply ref, :error, %{reason: "bad_message"}

    monitor = watch(guest_socket)
    ref = push(host_socket, "kick", %{"id" => guest.id})
    assert_reply ref, :ok
    assert_push "kicked", %{}
    assert_receive {:DOWN, ^monitor, _, _, _}
  end

  test "the host may come back with its token; else the session ends", context do
    %{session: session, host: host, host_socket: host_socket} = context
    {:ok, _guest, _} = enter(session, %{"role" => "guest"})

    Process.unlink(host_socket.channel_pid)
    close(host_socket)
    assert_push "host", %{present: false}

    {:ok, again, _} = enter(session, %{"role" => "host", "token" => host.token})
    assert again.id == host.id and again.token == nil
    assert [%{admitted: true}] = again.participants
    assert_push "host", %{present: true}

    {:ok, _, ended} = enter(session_id(), %{"role" => "host"})
    Process.unlink(ended.channel_pid)
    close(ended)
    refute_push "ended", %{}, 100
  end

  # The host's new socket joins before its old channel is gone.
  test "a host joining again replaces its old channel", context do
    %{session: session, host: host, host_socket: host_socket} = context
    Process.unlink(host_socket.channel_pid)
    monitor = watch(host_socket)
    {:ok, again, _} = enter(session, %{"role" => "host", "token" => host.token})
    assert again.id == host.id
    assert_receive {:DOWN, ^monitor, _, _, _}
  end

  test "a session whose host stays away ends", %{session: session, host_socket: host_socket} do
    {:ok, _guest, guest_socket} = enter(session, %{"role" => "guest"})
    monitor = watch(guest_socket)
    Process.unlink(host_socket.channel_pid)
    close(host_socket)
    assert_push "ended", %{}, 1000
    assert_receive {:DOWN, ^monitor, _, _, _}
    assert {:error, %{reason: "no_session"}} = enter(session, %{"role" => "guest"})
  end

  test "the host ends the session", %{session: session, host_socket: host_socket} do
    {:ok, _guest, _} = enter(session, %{"role" => "guest"})
    ref = push(host_socket, "end", %{})
    assert_reply ref, :ok
    assert_push "ended", %{}
  end

  test "a message over the size is refused", %{session: session} do
    {:ok, _guest, guest_socket} = enter(session, %{"role" => "guest"})
    ref = push(guest_socket, "b", {:binary, :binary.copy("x", 262_145)})
    assert_reply ref, :error, %{reason: "too_large"}
  end

  # 1,000 messages, a few microseconds apart: past the burst (800), the
  # rest wait for the rate (200 a second), and all arrive, in order.
  test "messages over the rate wait, and keep their order", %{session: session} do
    {:ok, guest, guest_socket} = enter(session, %{"role" => "guest"})
    assert_push "joined", %{}
    refs = for n <- 1..1000, do: push(guest_socket, "b", {:binary, <<n::32>>})
    for ref <- refs, do: assert_reply(ref, :ok, _, 5000)

    for n <- 1..1000 do
      assert_push "m", message
      assert message == message(guest.id, <<n::32>>)
    end
  end

  test "a participant whose messages pile up is closed", %{session: session} do
    {:ok, _guest, guest_socket} = enter(session, %{"role" => "guest"})
    monitor = watch(guest_socket)
    for _ <- 1..3000, do: push(guest_socket, "b", {:binary, "x"})
    assert_receive {:DOWN, ^monitor, _, _, _}, 5000
  end
end
