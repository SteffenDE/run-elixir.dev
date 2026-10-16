defmodule PlaygroundWeb.LiveChannel do
  @moduledoc """
  A participant in a live session (`live:ID`, see `Playground.Live`).

  Messages are binary and opaque:

    * `"b"`, data: to every other admitted participant;
    * `"s"`, `<<size, to::binary-size(size), data::binary>>`: to one.

  Both arrive as `"m"`, `<<size, from::binary-size(size), data::binary>>`,
  `from` stamped here. A guest waiting to be admitted may only send to the
  host. The host's commands are `"kick"`, `"admit"` (`%{"id" => id}`),
  `"admission"` (`%{"on" => boolean}`) and `"end"`. The session's news
  (`"joined"`, `"admitted"`, `"left"`, `"host"`, `"kicked"`, `"ended"`,
  `"replaced"`) comes as JSON events.

  Each participant may send so many bytes and messages a second, with a
  burst; a message over that waits, and those after it wait behind it, so
  their order holds. A participant whose messages keep piling up is closed
  (`{:error, %{reason: "overloaded"}}`).
  """

  use PlaygroundWeb, :channel

  alias Playground.Live

  @impl true
  def join("live:" <> session, params, socket) do
    with true <- Live.valid_id?(session) || {:error, "bad_id"},
         {:ok, welcome} <- Live.join(session, params["role"], params, self()) do
      :ok = Live.register(session, welcome.id, welcome.admitted)
      if welcome.room, do: Phoenix.PubSub.subscribe(Playground.PubSub, welcome.room)
      config = Application.get_env(:playground, Live, [])

      socket =
        assign(socket,
          session: session,
          id: welcome.id,
          host: welcome.host,
          host?: welcome.id == welcome.host,
          admitted: welcome.admitted,
          room: welcome.room,
          max_message: Keyword.get(config, :max_message, 262_144),
          rate: Keyword.get(config, :rate, bytes: 1_048_576, messages: 200),
          max_backlog: Keyword.get(config, :max_backlog, 1000),
          bucket: nil
        )

      {:ok, Map.delete(welcome, :room), socket}
    else
      {:error, reason} -> {:error, %{reason: reason}}
    end
  end

  @impl true
  def handle_in("b", {:binary, data}, socket) do
    cond do
      not socket.assigns.admitted -> {:reply, {:error, %{reason: "not_admitted"}}, socket}
      true -> relay(data, socket, &broadcast_message/2)
    end
  end

  def handle_in("s", {:binary, <<size, to::binary-size(size), data::binary>>}, socket) do
    relay(data, socket, fn data, socket -> direct(to, data, socket) end)
  end

  def handle_in(event, %{} = payload, %{assigns: %{host?: true}} = socket)
      when event in ~w(kick admit admission end) do
    command =
      case {event, payload} do
        {"kick", %{"id" => id}} -> {:kick, id}
        {"admit", %{"id" => id}} -> {:admit, id}
        {"admission", %{"on" => on?}} -> {:admission, on?}
        {"end", _} -> :end
        _ -> nil
      end

    case command && Live.command(socket.assigns.session, self(), command) do
      :ok -> {:reply, :ok, socket}
      {:error, reason} -> {:reply, {:error, %{reason: reason}}, socket}
      nil -> {:reply, {:error, %{reason: "bad_command"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket),
    do: {:reply, {:error, %{reason: "bad_message"}}, socket}

  # Size and rate first, then `send`.
  defp relay(data, socket, send) do
    with :ok <- if(byte_size(data) <= socket.assigns.max_message, do: :ok, else: "too_large"),
         {:ok, socket} <- take(socket, byte_size(data)),
         :ok <- send.(data, socket) do
      {:reply, :ok, socket}
    else
      :overloaded -> {:stop, :normal, {:error, %{reason: "overloaded"}}, socket}
      {:error, reason} -> {:reply, {:error, %{reason: reason}}, socket}
      reason when is_binary(reason) -> {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  defp broadcast_message(data, socket) do
    Phoenix.PubSub.broadcast_from(
      Playground.PubSub,
      self(),
      socket.assigns.room,
      {:live_message, socket.assigns.id, data}
    )
  end

  defp direct(to, data, socket) do
    %{session: session, id: id, host?: host?, admitted: admitted, host: host} = socket.assigns

    case Live.participant(session, to) do
      nil ->
        {:error, "unknown"}

      {pid, to_admitted} ->
        # The host reaches everyone; the admitted reach each other; one
        # waiting reaches only the host.
        if host? or (admitted and to_admitted) or to == host do
          send(pid, {:live_message, id, data})
          :ok
        else
          {:error, "not_admitted"}
        end
    end
  end

  # A token bucket per participant, for bytes and for messages: a second's
  # worth a second, and up to four seconds' worth at once, counted in
  # fractions (messages a few milliseconds apart each add a little). A
  # message over it waits until the bucket has it: this channel takes its
  # next message only then, so the order holds. Too many waiting behind:
  # :overloaded.
  defp take(socket, bytes) do
    %{rate: rate, max_backlog: max_backlog} = socket.assigns
    now = System.monotonic_time(:microsecond)
    full = {rate[:bytes] * 4.0, rate[:messages] * 4.0}

    {last, have_bytes, have_messages} =
      socket.assigns.bucket || {now, elem(full, 0), elem(full, 1)}

    seconds = (now - last) / 1_000_000
    have_bytes = min(elem(full, 0), have_bytes + rate[:bytes] * seconds)
    have_messages = min(elem(full, 1), have_messages + rate[:messages] * seconds)

    wait =
      max(0.0, max((bytes - have_bytes) / rate[:bytes], (1 - have_messages) / rate[:messages]))

    {:message_queue_len, backlog} = Process.info(self(), :message_queue_len)

    cond do
      wait > 0 and backlog > max_backlog ->
        :overloaded

      true ->
        if wait > 0, do: Process.sleep(ceil(wait * 1000))
        have_bytes = have_bytes + rate[:bytes] * wait - bytes
        have_messages = have_messages + rate[:messages] * wait - 1
        bucket = {now + round(wait * 1_000_000), have_bytes, have_messages}
        {:ok, assign(socket, :bucket, bucket)}
    end
  end

  @impl true
  def handle_info({:live_message, from, data}, socket) do
    push(socket, "m", {:binary, <<byte_size(from), from::binary, data::binary>>})
    {:noreply, socket}
  end

  def handle_info({:live_admitted, room}, socket) do
    :ok = Live.admitted(socket.assigns.session, socket.assigns.id)
    Phoenix.PubSub.subscribe(Playground.PubSub, room)
    {:noreply, assign(socket, admitted: true, room: room)}
  end

  def handle_info({:live, event, payload}, socket) when event in ~w(kicked ended replaced) do
    push(socket, event, payload)
    {:stop, :normal, socket}
  end

  def handle_info({:live, event, payload}, socket) do
    push(socket, event, payload)
    {:noreply, socket}
  end
end
