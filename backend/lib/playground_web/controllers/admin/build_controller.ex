defmodule PlaygroundWeb.Admin.BuildController do
  use PlaygroundWeb, :controller

  alias Playground.{Nif, Repo}
  alias PlaygroundWeb.Admin.JSON

  def index(conn, params) do
    json(conn, %{builds: Enum.map(Nif.list_builds(params), &JSON.build/1)})
  end

  def show(conn, %{"id" => id}) do
    case Repo.get(Nif.Build, id) do
      nil -> conn |> put_status(404) |> json(%{error: "no such build"})
      build -> json(conn, %{build: JSON.build(build, log: true)})
    end
  end

  # Requests a build as an admin: an agent session may set up any package.
  def create(conn, %{"package" => package, "version" => version}) do
    case Nif.request(package, version, admin: true) do
      {:ok, build} -> conn |> put_status(201) |> json(%{build: JSON.build(build)})
      {:error, reason} -> conn |> put_status(422) |> json(%{error: inspect(reason)})
    end
  end

  def retry(conn, %{"id" => id}) do
    case Repo.get(Nif.Build, id) do
      nil ->
        conn |> put_status(404) |> json(%{error: "no such build"})

      build ->
        {:ok, build} = Nif.retry(build)
        json(conn, %{build: JSON.build(build)})
    end
  end
end
