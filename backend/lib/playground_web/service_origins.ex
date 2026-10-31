defmodule PlaygroundWeb.ServiceOrigins do
  @moduledoc """
  The pages whose browsers may use the backend's services (docs/backend.md):
  the TCP relay (`/relay`) and NIF builds (`/api/v1/nif/`). The page's own
  worker on its own origin asks for them (the api package's apex worker,
  docs/frames.md), so the browser sends that page's `Origin`.

  `config :playground, :service_origins` lists exact origins
  (`https://tidewave.ai`); unset, any origin is let (developing). An origin
  is a browser's claim, not a boundary for other clients: it keeps other
  sites' pages from using the services through their visitors' browsers.

  `require_allowed/2` refuses a browser's request from another page before
  any work: 403 for an `Origin` not on the list, and for a request without
  one that the browser marks `Sec-Fetch-Site: cross-site` (another site's
  `<img>` or `<script>`, which sends no `Origin`). A request with neither
  (a non-browser client, or the apex's same-origin GET through the proxy)
  goes on, as before: such a client can send any `Origin` it likes.
  """

  @doc "Whether a page of `origin` (a string or a URI) may use the services."
  def allowed?(nil), do: false

  def allowed?(%URI{scheme: scheme, host: host, port: port}) when is_binary(host) do
    allowed?(origin(scheme, host, port))
  end

  def allowed?(%URI{}), do: false

  def allowed?(origin) when is_binary(origin) do
    case Application.get_env(:playground, :service_origins) do
      nil -> true
      origins -> normalize(origin) in Enum.map(origins, &normalize/1)
    end
  end

  # An origin as browsers send it: the scheme, the host and a port only
  # when it is not the scheme's default.
  defp origin(scheme, host, port) do
    default = URI.default_port(scheme || "")
    if port in [nil, default], do: "#{scheme}://#{host}", else: "#{scheme}://#{host}:#{port}"
  end

  defp normalize(origin) do
    case URI.parse(String.trim(origin)) do
      %URI{scheme: scheme, host: host, port: port} when is_binary(host) ->
        origin(String.downcase(scheme || ""), String.downcase(host), port)

      _ ->
        origin
    end
  end

  @doc """
  Whether `conn`'s request may use the services (`require_allowed/2`).
  """
  def request_allowed?(conn) do
    case Plug.Conn.get_req_header(conn, "origin") do
      [origin | _] -> allowed?(origin)
      [] -> Plug.Conn.get_req_header(conn, "sec-fetch-site") != ["cross-site"]
    end
  end

  @doc """
  A plug: 403, halted, for a request `request_allowed?/1` refuses.
  """
  def require_allowed(conn, _opts \\ []) do
    if request_allowed?(conn) do
      conn
    else
      conn
      |> Plug.Conn.put_resp_content_type("text/plain")
      |> Plug.Conn.send_resp(403, "This page's origin may not use these services.")
      |> Plug.Conn.halt()
    end
  end

  @doc """
  CORS for an allowed origin's request: its origin echoed, with `Vary`.
  Another origin's request gets no CORS headers, so its page cannot read
  the answer.
  """
  def put_cors(conn, _opts \\ []) do
    case Plug.Conn.get_req_header(conn, "origin") do
      [origin | _] ->
        if allowed?(origin) do
          conn
          |> Plug.Conn.put_resp_header("access-control-allow-origin", origin)
          |> Plug.Conn.put_resp_header("vary", "Origin")
        else
          conn
        end

      [] ->
        conn
    end
  end
end
