defmodule Playground.NifTest do
  use Playground.DataCase, async: true
  use Oban.Testing, repo: Playground.Repo

  alias Playground.Nif
  alias Playground.Nif.{Build, Recipe, Setup, SetupWorker}

  test "the newest template that applies to a version builds it" do
    {:ok, old} = Nif.create_template(%{"package" => "demo", "recipe" => %{"script" => "make"}})

    {:ok, new} =
      Nif.create_template(%{
        "package" => "demo",
        "requirement" => ">= 2.0.0",
        "recipe" => %{"script" => "make all"}
      })

    assert Nif.template_for("demo", "1.4.0").id == old.id
    assert Nif.template_for("demo", "2.1.0").id == new.id
    assert Nif.template_for("other", "1.0.0") == nil
  end

  test "keeps a successful build's library and marks its template proven" do
    {:ok, template} =
      Nif.create_template(%{"package" => "demo", "recipe" => %{"script" => "make"}})

    build = build!("1.0.0", "running")

    build = Nif.succeed(build, template, result())

    assert %Build{status: "succeeded", app: "demo", size: 3} = build
    assert File.read!(Nif.artifact_path(build)) == "tar"
    assert Repo.reload!(template).proven_version == "1.0.0"
  end

  test "hands a build to the agent, and adopts the template it writes" do
    build = build!("1.0.0", "running")

    assert {:ok, %Build{status: "setting_up"}} = Nif.set_up(build, nil, nil, admin: true)
    assert_enqueued(worker: SetupWorker, args: %{"build_id" => build.id})

    setup = Nif.start_setup(build)
    {:ok, recipe} = Recipe.new(%{"script" => "make"})
    outcome = %{recipe: recipe, requirement: nil, notes: "Plain make.", build: result()}

    assert {:ok, %Build{status: "succeeded"}} = Nif.adopt(build, setup, outcome)
    assert %{status: "succeeded", template_id: id} = Repo.reload!(setup)
    assert %{origin: "agent", proven_version: "1.0.0"} = Repo.get!(Nif.Template, id)
  end

  test "fails a build when the agent's daily budget is spent" do
    Repo.insert!(%Setup{
      package: "x",
      version: "1.0.0",
      status: "failed",
      model: "m",
      cost_usd: 100.0
    })

    build = build!("1.0.0", "running")

    assert {:ok, %Build{status: "failed", error: "the agent's daily budget is spent"}} =
             Nif.set_up(build, nil, nil, admin: true)

    refute_enqueued(worker: SetupWorker)
  end

  test "records a setup's messages and usage as they come" do
    setup = Nif.start_setup(build!("1.0.0", "setting_up"))

    Nif.record(setup, %{"role" => "user", "content" => "hi"}, %{})

    Nif.record(setup, %{"role" => "assistant"}, %{
      input_tokens: 10,
      output_tokens: 2,
      cost_usd: 0.5
    })

    assert %{messages: [%{"content" => "hi"}, %{"role" => "assistant"}], input_tokens: 10} =
             setup = Repo.reload!(setup)

    assert setup.cost_usd == 0.5
  end

  defp build!(version, status) do
    Repo.insert!(%Build{package: "demo", version: version, toolchain: "test", status: status})
  end

  defp result, do: %{app: "demo", tar: "tar", files: [], log: "ok", duration_ms: 5}
end
