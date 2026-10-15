defmodule PlaygroundWeb.Admin.PageController do
  @moduledoc """
  The admin page (priv/admin): turns notifications on for a browser and
  lists recent builds. A web app, so an iPhone can receive notifications
  once it is on the home screen.
  """

  use PlaygroundWeb, :controller

  def index(conn, _params), do: file(conn, "index.html", "text/html")

  # Served from /admin/, so its scope is the page's.
  def service_worker(conn, _params) do
    conn |> put_resp_header("cache-control", "no-cache") |> file("sw.js", "text/javascript")
  end

  def manifest(conn, _params), do: file(conn, "manifest.webmanifest", "application/manifest+json")

  defp file(conn, name, type) do
    conn
    |> put_resp_content_type(type)
    |> send_file(200, Application.app_dir(:playground, Path.join("priv/admin", name)))
  end
end
