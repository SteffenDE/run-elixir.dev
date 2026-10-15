defmodule PlaygroundWeb.Admin.SetupController do
  use PlaygroundWeb, :controller

  alias Playground.{Nif, Repo}
  alias PlaygroundWeb.Admin.JSON

  def index(conn, params) do
    json(conn, %{setups: Enum.map(Nif.list_setups(params), &JSON.setup/1)})
  end

  def show(conn, %{"id" => id}) do
    case Repo.get(Nif.Setup, id) do
      nil -> conn |> put_status(404) |> json(%{error: "no such setup"})
      setup -> json(conn, %{setup: JSON.setup(setup, messages: true)})
    end
  end
end
