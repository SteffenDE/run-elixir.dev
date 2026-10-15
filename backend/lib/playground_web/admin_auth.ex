defmodule PlaygroundWeb.AdminAuth do
  @moduledoc """
  Lets in admins: GitHub logins in `:admin_logins` (`SteffenDE` by default),
  signed in through `PlaygroundWeb.AuthController` (after SCA's).

  Others are sent to sign in from a page, or answered 401 from the API.
  Changes through the API must be JSON, which a form on another site can't
  send (on top of the session cookie being `SameSite=Lax`).
  """

  @behaviour Plug

  import Plug.Conn
  import Phoenix.Controller

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    login = get_session(conn, :github_login)

    cond do
      not admin?(login) and conn.path_info |> List.first() == "api" ->
        conn |> put_status(401) |> json(%{error: "sign in at /auth/github"}) |> halt()

      not admin?(login) ->
        conn |> redirect(to: "/auth/github") |> halt()

      conn.method not in ~w(GET HEAD) and not json?(conn) ->
        conn |> put_status(415) |> json(%{error: "send JSON"}) |> halt()

      true ->
        assign(conn, :admin, login)
    end
  end

  def admin?(login), do: is_binary(login) and login in logins()

  defp logins, do: Application.get_env(:playground, :admin_logins, ["SteffenDE"])

  defp json?(conn) do
    case get_req_header(conn, "content-type") do
      ["application/json" <> _] -> true
      _other -> false
    end
  end
end
