defmodule Playground.Live do
  @moduledoc """
  Live sessions' relay (playground/docs/collaboration.md): which browsers
  are in a session, and who may hear whom. What they send each other is
  encrypted in the browser; the relay only passes it on.

  A session is a process (`Playground.Live.Session`), registered by its id
  and started by its host's first join. Participants are channel processes
  (`PlaygroundWeb.LiveChannel`), each registered under `{session, id}` with
  whether it was admitted, so a channel finds another without asking the
  session. The admitted ones also subscribe to `room/1`, the session's
  broadcasts.
  """

  alias Playground.Live.Session

  @registry Playground.Live.Registry

  @doc "Whether `id` looks like a session id: 128 bits, base64url."
  def valid_id?(id), do: is_binary(id) and id =~ ~r/\A[A-Za-z0-9_-]{22}\z/

  @doc "The PubSub topic of a session's admitted participants."
  def room(session), do: "live-room:" <> session

  @doc """
  Joins `pid` (a channel) to `session` as `role` ("host" or "guest").

  A host's first join starts the session and gets its token; a host joins
  again (a reload) with that token. Guests join sessions that exist.
  Answers `{:ok, %{id, host, token, admitted}}` or `{:error, reason}`.
  """
  def join(session, role, params, pid) do
    case {role, lookup(session)} do
      {"host", nil} ->
        spec = {Session, id: session, admit: params["admit"] == true}

        case DynamicSupervisor.start_child(Playground.Live.Supervisor, spec) do
          {:ok, server} -> GenServer.call(server, {:create, pid})
          {:error, {:already_started, server}} -> host_join(server, params, pid)
          {:error, _} -> {:error, "unavailable"}
        end

      {"host", server} ->
        host_join(server, params, pid)

      {"guest", nil} ->
        {:error, "no_session"}

      {"guest", server} ->
        call(server, {:guest, pid})

      _ ->
        {:error, "bad_role"}
    end
  end

  defp host_join(server, %{"token" => token}, pid) when is_binary(token),
    do: call(server, {:host, token, pid})

  defp host_join(_server, _params, _pid), do: {:error, "taken"}

  @doc "A host's command: `{:kick, id}`, `{:admit, id}`, `{:admission, on?}` or `:end`."
  def command(session, pid, command) do
    case lookup(session) do
      nil -> {:error, "no_session"}
      server -> call(server, {:command, pid, command})
    end
  end

  @doc "The channel of participant `id` in `session`, and whether it was admitted."
  def participant(session, id) do
    case Registry.lookup(@registry, {session, id}) do
      [{pid, admitted}] -> {pid, admitted}
      [] -> nil
    end
  end

  @doc false
  def register(session, id, admitted) do
    {:ok, _} = Registry.register(@registry, {session, id}, admitted)
    :ok
  end

  @doc false
  def admitted(session, id) do
    Registry.update_value(@registry, {session, id}, fn _ -> true end)
    :ok
  end

  @doc false
  def via(session), do: {:via, Registry, {@registry, {:session, session}}}

  defp lookup(session) do
    case Registry.lookup(@registry, {:session, session}) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  # A session that ends between the lookup and the call has no answer.
  defp call(server, message) do
    GenServer.call(server, message)
  catch
    :exit, _ -> {:error, "no_session"}
  end
end
