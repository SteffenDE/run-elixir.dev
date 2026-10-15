defmodule PlaygroundWeb.AuthController do
  use PlaygroundWeb, :controller

  def request(conn, _params) do
    state = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

    conn
    |> put_session(:github_state, state)
    |> redirect(external: Playground.GitHubOAuth.authorize_url(state))
  end

  def callback(conn, params) do
    expected_state = get_session(conn, :github_state)
    conn = delete_session(conn, :github_state)

    with %{"code" => code, "state" => state} <- params,
         true <- is_binary(expected_state) and Plug.Crypto.secure_compare(state, expected_state),
         {:ok, token} <- Playground.GitHubOAuth.fetch_token(code),
         {:ok, %{"login" => login}} <- Playground.GitHubOAuth.fetch_user(token),
         true <- PlaygroundWeb.AdminAuth.admin?(login) do
      conn
      |> configure_session(renew: true)
      |> put_session(:github_login, login)
      |> redirect(to: ~p"/admin")
    else
      _ ->
        conn
        |> put_status(:bad_request)
        |> text("Bad request")
    end
  end

  def delete(conn, _params) do
    conn
    |> configure_session(drop: true)
    |> redirect(to: ~p"/auth/github")
  end
end
