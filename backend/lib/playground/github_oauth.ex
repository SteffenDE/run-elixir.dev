defmodule Playground.GitHubOAuth do
  @moduledoc """
  Signs admins in with GitHub (from SCA): `:client_id` and `:client_secret`
  of an OAuth app whose callback is `/auth/github/callback`.
  """

  def authorize_url(state) do
    config = config()

    query =
      URI.encode_query(
        client_id: config[:client_id],
        state: state
      )

    "https://github.com/login/oauth/authorize?" <> query
  end

  def fetch_token(code) do
    config = config()

    result =
      request(
        "https://github.com/login/oauth/access_token",
        method: :post,
        form: [
          client_id: config[:client_id],
          client_secret: config[:client_secret],
          code: code
        ],
        headers: [accept: "application/json"]
      )

    case result do
      {:ok, %{status: 200, body: %{"access_token" => token}}} ->
        {:ok, token}

      {:ok, resp} ->
        {:error, resp}

      {:error, exception} ->
        {:error, exception}
    end
  end

  def fetch_user(token) do
    case request("https://api.github.com/user", auth: {:bearer, token}) do
      {:ok, %{status: 200, body: user}} -> {:ok, user}
      {:ok, resp} -> {:error, resp}
      {:error, exception} -> {:error, exception}
    end
  end

  defp request(url, options) do
    Req.request([url: url] ++ req_options() ++ options)
  end

  if Mix.env() == :test do
    defp req_options, do: [plug: {Req.Test, __MODULE__}]
  else
    defp req_options, do: []
  end

  defp config do
    Application.fetch_env!(:playground, __MODULE__)
  end
end
