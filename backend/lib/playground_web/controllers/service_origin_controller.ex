defmodule PlaygroundWeb.ServiceOriginController do
  @moduledoc """
  `GET /api/v1/origin`: 204 when the request's page may use the services
  (`PlaygroundWeb.ServiceOrigins`; the router's `:public` pipeline answers
  403 otherwise). Caddy asks it with the original request's headers
  (`forward_auth`) before its git proxy, which the backend does not serve.
  """

  use PlaygroundWeb, :controller

  def show(conn, _params), do: send_resp(conn, 204, "")
end
