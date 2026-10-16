defmodule Playground.Live.Session do
  @moduledoc """
  One live session: its host, its guests, and whether guests wait to be
  admitted. It tells participants who comes and goes (as `{:live, event,
  payload}` messages to their channels) and ends when its host has been
  gone for the grace period, when the host ends it, or after its maximum
  lifetime.

  What participants see of each other: the host sees everyone, an
  admitted guest sees the admitted ones, a waiting guest sees only itself
  being admitted (or kicked).
  """

  use GenServer, restart: :temporary

  alias Playground.Live

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: Live.via(Keyword.fetch!(opts, :id)))

  @impl true
  def init(opts) do
    config = Application.get_env(:playground, Live, [])
    Process.send_after(self(), :expire, Keyword.get(config, :lifetime_ms, :timer.hours(24)))

    {:ok,
     %{
       id: Keyword.fetch!(opts, :id),
       admit: Keyword.fetch!(opts, :admit),
       token_hash: nil,
       host: Live.Ids.participant(),
       host_pid: nil,
       grace: nil,
       # id => %{pid, admitted}, the guests
       guests: %{},
       max: Keyword.get(config, :max_participants, 16),
       grace_ms: Keyword.get(config, :grace_ms, 30_000)
     }}
  end

  @impl true
  def handle_call({:create, pid}, _from, %{token_hash: nil} = state) do
    token = Live.Ids.token()
    state = %{state | token_hash: hash(token)} |> host_in(pid)
    {:reply, {:ok, welcome(state, state.host, true, token)}, state}
  end

  def handle_call({:create, pid}, from, state), do: handle_call({:host, nil, pid}, from, state)

  def handle_call({:host, token, pid}, _from, state) do
    if is_binary(token) and Plug.Crypto.secure_compare(hash(token), state.token_hash) do
      # A host that comes back before its old page's socket closed: the
      # old one goes.
      if state.host_pid, do: send(state.host_pid, {:live, "replaced", %{}})
      state = host_in(state, pid)
      notify(state, :admitted, "host", %{present: true})
      {:reply, {:ok, welcome(state, state.host, true, nil)}, state}
    else
      {:reply, {:error, "taken"}, state}
    end
  end

  def handle_call({:guest, pid}, _from, state) do
    if map_size(state.guests) + 1 >= state.max do
      {:reply, {:error, "full"}, state}
    else
      id = Live.Ids.participant()
      admitted = not state.admit
      Process.monitor(pid)
      state = put_in(state.guests[id], %{pid: pid, admitted: admitted})
      payload = %{id: id, admitted: admitted}
      notify(state, if(admitted, do: :admitted, else: :host), "joined", payload, id)
      {:reply, {:ok, welcome(state, id, admitted, nil)}, state}
    end
  end

  def handle_call({:command, pid, command}, _from, %{host_pid: pid} = state) do
    {reply, state} = command(command, state)

    case state do
      :stop -> {:stop, :normal, :ok, nil}
      state -> {:reply, reply, state}
    end
  end

  def handle_call({:command, _pid, _command}, _from, state),
    do: {:reply, {:error, "not_host"}, state}

  defp command({:kick, id}, state) do
    case Map.pop(state.guests, id) do
      {nil, _} ->
        {{:error, "unknown"}, state}

      {guest, guests} ->
        send(guest.pid, {:live, "kicked", %{}})
        state = %{state | guests: guests}
        notify(state, if(guest.admitted, do: :admitted, else: :host), "left", %{id: id})
        {:ok, state}
    end
  end

  defp command({:admit, id}, state) do
    case state.guests[id] do
      %{admitted: false} = guest ->
        state = put_in(state.guests[id].admitted, true)
        send(guest.pid, {:live_admitted, Live.room(state.id)})
        notify(state, :admitted, "admitted", %{id: id})
        {:ok, state}

      %{admitted: true} ->
        {:ok, state}

      nil ->
        {{:error, "unknown"}, state}
    end
  end

  defp command({:admission, on?}, state), do: {:ok, %{state | admit: on? == true}}

  defp command(:end, state) do
    notify(state, :everyone, "ended", %{})
    {:ok, :stop}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, %{host_pid: pid} = state) do
    timer = Process.send_after(self(), :grace_over, state.grace_ms)
    state = %{state | host_pid: nil, grace: timer}
    notify(state, :admitted, "host", %{present: false})
    {:noreply, state}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    case Enum.find(state.guests, fn {_id, guest} -> guest.pid == pid end) do
      nil ->
        {:noreply, state}

      {id, guest} ->
        state = %{state | guests: Map.delete(state.guests, id)}
        notify(state, if(guest.admitted, do: :admitted, else: :host), "left", %{id: id})
        {:noreply, state}
    end
  end

  def handle_info(:grace_over, %{host_pid: nil} = state) do
    notify(state, :everyone, "ended", %{})
    {:stop, :normal, state}
  end

  def handle_info(:grace_over, state), do: {:noreply, state}

  def handle_info(:expire, state) do
    notify(state, :everyone, "ended", %{})
    if state.host_pid, do: send(state.host_pid, {:live, "ended", %{}})
    {:stop, :normal, state}
  end

  defp host_in(state, pid) do
    if state.grace, do: Process.cancel_timer(state.grace)
    Process.monitor(pid)
    %{state | host_pid: pid, grace: nil}
  end

  # What a participant learns on joining: its id, the host's, who else is
  # there (as far as it may see), and the host's token on creating.
  defp welcome(state, id, admitted, token) do
    host? = id == state.host

    others =
      for {other, guest} <- state.guests,
          other != id,
          host? or (admitted and guest.admitted),
          do: %{id: other, admitted: guest.admitted}

    %{
      id: id,
      host: state.host,
      host_present: state.host_pid != nil,
      admitted: admitted,
      room: if(admitted, do: Live.room(state.id)),
      participants: if(admitted, do: others, else: []),
      token: token
    }
  end

  # Tells participants: `:host` only, `:admitted` (the host and admitted
  # guests) or `:everyone`, leaving out `except` (an id).
  defp notify(state, who, event, payload, except \\ nil) do
    host = if state.host_pid, do: [state.host_pid], else: []

    guests =
      for {id, guest} <- state.guests,
          id != except,
          who == :everyone or (who == :admitted and guest.admitted),
          do: guest.pid

    for pid <- host ++ guests, do: send(pid, {:live, event, payload})
  end

  defp hash(token), do: :crypto.hash(:sha256, token)
end
