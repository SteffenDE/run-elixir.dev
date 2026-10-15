defmodule PlaygroundWeb.Admin.TemplateController do
  use PlaygroundWeb, :controller

  alias Playground.{Nif, Repo}
  alias PlaygroundWeb.Admin.JSON

  def index(conn, params) do
    json(conn, %{templates: Enum.map(Nif.list_templates(params), &JSON.template/1)})
  end

  def show(conn, %{"id" => id}) do
    with_template(conn, id, &json(conn, %{template: JSON.template(&1)}))
  end

  def create(conn, params) do
    params
    |> Map.take(~w(package requirement recipe notes))
    |> Nif.create_template()
    |> reply(conn, 201)
  end

  def update(conn, %{"id" => id} = params) do
    with_template(conn, id, fn template ->
      template
      |> Nif.update_template(Map.take(params, ~w(requirement recipe notes)))
      |> reply(conn, 200)
    end)
  end

  def delete(conn, %{"id" => id}) do
    with_template(conn, id, fn template ->
      Repo.delete!(template)
      send_resp(conn, 204, "")
    end)
  end

  defp with_template(conn, id, fun) do
    case Repo.get(Nif.Template, id) do
      nil -> conn |> put_status(404) |> json(%{error: "no such template"})
      template -> fun.(template)
    end
  end

  defp reply({:ok, template}, conn, status),
    do: conn |> put_status(status) |> json(%{template: JSON.template(template)})

  defp reply({:error, changeset}, conn, _status),
    do: conn |> put_status(422) |> json(%{errors: JSON.errors(changeset)})
end
