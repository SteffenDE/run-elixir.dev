defmodule Playground.Nif.SetupWorker do
  @moduledoc """
  Runs `Playground.Nif.Agent` for a build no template builds. Setups run once
  (they cost money): one that fails fails its build, and is notified.
  """

  use Oban.Worker,
    queue: :setups,
    max_attempts: 1,
    unique: [keys: [:build_id], states: :incomplete]

  alias Playground.{Nif, Repo}
  alias Playground.Nif.{Agent, Build, BuildWorker, Template}

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"build_id" => id} = args}) do
    case Repo.get(Build, id) do
      %Build{status: "setting_up"} = build -> set_up(build, args)
      _gone_or_done -> :ok
    end
  end

  defp set_up(build, args) do
    failed = args["template_id"] && Repo.get(Template, args["template_id"])
    template = Nif.template_for(build.package, build.version)

    # Another version's setup may have written one meanwhile.
    if template && template.id != args["template_id"] do
      build = build |> Ecto.Changeset.change(status: "queued") |> Repo.update!()
      {:ok, _job} = Oban.insert(BuildWorker.new(%{build_id: build.id}))
      :ok
    else
      setup = Nif.start_setup(build)
      previous = if failed, do: %{template: failed, failure: args["failure"] || %{}}
      record = fn message, usage -> Nif.record(setup, message, usage) end

      case Agent.run(build.package, build.version, previous, record) do
        {:ok, outcome} ->
          {:ok, _build} = Nif.adopt(build, setup, outcome)

        {:unsupported, reason} ->
          Nif.finish_setup(setup, status: "failed", summary: reason, error: "unsupported")
          {:ok, _build} = Nif.fail(build, reason, nil, "unsupported")

        {:failed, reason} ->
          error = if is_binary(reason), do: reason, else: inspect(reason)
          Nif.finish_setup(setup, status: "failed", error: error)
          {:ok, _build} = Nif.fail(build, "the agent failed: #{error}", nil)
      end

      :ok
    end
  end
end
