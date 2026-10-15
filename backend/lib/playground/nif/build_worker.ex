defmodule Playground.Nif.BuildWorker do
  @moduledoc """
  Builds a `Playground.Nif.Build` with the template for its version, or hands
  it to `Playground.Nif.SetupWorker` when there is none or it fails.
  """

  use Oban.Worker,
    queue: :builds,
    max_attempts: 3,
    unique: [keys: [:build_id], states: :incomplete]

  alias Playground.{Nif, Repo}
  alias Playground.Nif.{Build, Recipe, Runner}

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"build_id" => id} = args}) do
    case Repo.get(Build, id) do
      %Build{status: status} = build when status in ["queued", "running"] ->
        build(build, admin: args["admin"] == true)

      _gone_or_done ->
        :ok
    end
  end

  defp build(build, opts) do
    build = build |> Ecto.Changeset.change(status: "running") |> Repo.update!()

    case Nif.template_for(build.package, build.version) do
      nil ->
        {:ok, _build} = Nif.set_up(build, nil, nil, opts)
        :ok

      template ->
        {:ok, recipe} = Recipe.new(template.recipe)

        case Runner.run(build.package, build.version, recipe) do
          {:ok, result} ->
            Nif.succeed(build, template, result)
            :ok

          {:error, failure} ->
            build = build |> Ecto.Changeset.change(log: failure.log) |> Repo.update!()
            {:ok, _build} = Nif.set_up(build, template, Map.take(failure, [:reason, :log]), opts)
            :ok
        end
    end
  end
end
