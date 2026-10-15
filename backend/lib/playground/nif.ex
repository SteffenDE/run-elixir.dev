defmodule Playground.Nif do
  @moduledoc """
  NIF libraries built to WebAssembly, on request, for the playground's
  `make` (playground/docs/nif.md).

  A request for a package version (`request/2`) finds its build, or queues
  one (`Playground.Nif.BuildWorker`). A build runs the newest template that
  applies to the version (`Playground.Nif.Template`) in a sandbox VM. Without
  one, or when it fails, `Playground.Nif.SetupWorker` has
  `Playground.Nif.Agent` write a new template, which later versions reuse.
  Failures, and every template the agent writes, are notified
  (`Playground.Notifications`), so a person can review them.

  Builds are kept per toolchain (the rootfs's erl_nif layer, nifcc and
  wasi-sdk): a new toolchain builds every version anew when it is requested.

  Configuration (`config :playground, Playground.Nif`): `:allowed_hosts`,
  the hosts recipes may let builds connect to; `:daily_budget_usd`, what
  agent sessions may spend in a day; `:setup_min_downloads`, the downloads a
  package needs for an agent session that no admin asked for; `:cpus` and
  `:memory_mib` of build VMs; `:admin_url`, linked from notifications.
  """

  import Ecto.Query

  alias Playground.{Hex, Notification, Notifications, Repo, Sandbox}
  alias Playground.Nif.{Build, BuildWorker, Recipe, Setup, SetupWorker, Template}

  # Hex's (for mix deps.get), and where packages' Makefiles fetch sources.
  @default_hosts ~w(
    repo.hex.pm builds.hex.pm
    github.com codeload.github.com objects.githubusercontent.com raw.githubusercontent.com
    release-assets.githubusercontent.com gitlab.com codeberg.org
  )

  def config, do: Application.get_env(:playground, __MODULE__, [])

  @doc """
  The hosts recipes may let builds connect to.
  """
  def allowed_hosts, do: config()[:allowed_hosts] || @default_hosts

  @doc """
  The toolchain the sandbox's rootfs builds with, from its manifest.
  """
  def toolchain do
    case :persistent_term.get({__MODULE__, :toolchain}, nil) do
      nil ->
        manifest = Path.join(Sandbox.artifacts_dir(), "manifest.json")
        toolchain = manifest |> File.read!() |> JSON.decode!() |> Map.fetch!("toolchain")
        :persistent_term.put({__MODULE__, :toolchain}, toolchain)
        toolchain

      toolchain ->
        toolchain
    end
  end

  @doc """
  Where a build's library archive is kept.
  """
  def artifact_path(%Build{} = build),
    do:
      Path.join([
        Playground.data_dir(),
        "nif",
        build.toolchain,
        "#{build.package}-#{build.version}.tar"
      ])

  @doc """
  Returns the build of a package version with the current toolchain, queueing
  it when there is none. A failed build is not retried here, see `retry/1`.

  An admin's request (`admin: true`) may start an agent session for any
  package, others only for packages with `:setup_min_downloads`.
  """
  @spec request(String.t(), String.t(), keyword()) :: {:ok, Build.t()} | {:error, term()}
  def request(name, version, opts \\ []) do
    toolchain = toolchain()

    case Repo.get_by(Build, package: name, version: version, toolchain: toolchain) do
      %Build{} = build ->
        {:ok, build}

      nil ->
        # Only versions Hex has: the registry is the gate for what is built.
        with {:ok, _release} <- Hex.release(name, version) do
          queue(%Build{package: name, version: version, toolchain: toolchain}, opts)
        end
    end
  end

  defp queue(build, opts) do
    Repo.transact(fn ->
      with {:ok, build} <-
             build
             |> Ecto.Changeset.change(status: "queued")
             |> Ecto.Changeset.unique_constraint([:package, :version, :toolchain])
             |> Repo.insert(),
           {:ok, _job} <- Oban.insert(BuildWorker.new(worker_args(build, opts))) do
        {:ok, build}
      end
    end)
    |> case do
      {:error, %Ecto.Changeset{}} ->
        # Requested at the same time: the other request queued it.
        {:ok,
         Repo.get_by!(Build,
           package: build.package,
           version: build.version,
           toolchain: build.toolchain
         )}

      result ->
        result
    end
  end

  @doc """
  Queues a build again, whatever became of it.
  """
  def retry(%Build{} = build, opts \\ [admin: true]) do
    Repo.transact(fn ->
      build = build |> Ecto.Changeset.change(status: "queued", error: nil) |> Repo.update!()
      {:ok, _job} = Oban.insert(BuildWorker.new(worker_args(build, opts)))
      {:ok, build}
    end)
  end

  defp worker_args(build, opts),
    do: %{build_id: build.id, admin: Keyword.get(opts, :admin, false)}

  @doc """
  Returns the newest template that applies to the version.
  """
  def template_for(name, version) do
    from(t in Template, where: t.package == ^name, order_by: [desc: t.inserted_at, desc: t.id])
    |> Repo.all()
    |> Enum.find(&Template.applies?(&1, version))
  end

  @doc """
  Saves a template; `origin` is `"admin"` unless the attributes say otherwise.
  """
  def create_template(attrs) do
    attrs = Map.put_new(attrs, "origin", "admin")
    %Template{} |> Template.changeset(attrs) |> Repo.insert()
  end

  def update_template(%Template{} = template, attrs),
    do: template |> Template.changeset(attrs) |> Repo.update()

  @doc """
  Records a library a build made: its archive goes to `artifact_path/1`.
  """
  def succeed(%Build{} = build, %Template{} = template, result) do
    path = artifact_path(build)
    tmp = "#{path}.#{System.unique_integer([:positive])}"
    File.mkdir_p!(Path.dirname(path))
    File.write!(tmp, result.tar)
    File.rename!(tmp, path)

    if template.proven_version == nil do
      template |> Ecto.Changeset.change(proven_version: build.version) |> Repo.update!()
    end

    build
    |> Ecto.Changeset.change(
      status: "succeeded",
      template_id: template.id,
      app: result.app,
      sha256: Base.encode16(:crypto.hash(:sha256, result.tar), case: :lower),
      size: byte_size(result.tar),
      log: result.log,
      error: nil,
      duration_ms: result.duration_ms
    )
    |> Repo.update!()
  end

  @doc """
  Hands a build to the agent: with no template (`template` is `nil`), or
  after `template` failed with `failure`. Fails it when the day's budget is
  spent, or when nobody asked for a new package too few people use.
  """
  def set_up(%Build{} = build, template, failure, opts \\ []) do
    cond do
      spent_today() >= (config()[:daily_budget_usd] || 20.0) ->
        fail(build, "the agent's daily budget is spent", failure && failure.log)

      template == nil and not Keyword.get(opts, :admin, false) and not popular?(build.package) ->
        fail(
          build,
          "no template builds it, and it has too few downloads for an agent session " <>
            "nobody asked for: retry it as an admin",
          failure && failure.log
        )

      true ->
        hand_over(build, template, failure)
    end
  end

  defp popular?(name) do
    case Hex.downloads(name) do
      {:ok, downloads} -> downloads >= (config()[:setup_min_downloads] || 0)
      {:error, _reason} -> false
    end
  end

  defp hand_over(build, template, failure) do
    args =
      %{build_id: build.id}
      |> Map.merge(if template, do: %{template_id: template.id, failure: failure}, else: %{})

    Repo.transact(fn ->
      build = build |> Ecto.Changeset.change(status: "setting_up") |> Repo.update!()
      {:ok, _job} = Oban.insert(SetupWorker.new(args))
      {:ok, build}
    end)
  end

  defp spent_today do
    since = DateTime.add(DateTime.utc_now(), -1, :day)

    Repo.one(
      from s in Setup, where: s.inserted_at > ^since, select: coalesce(sum(s.cost_usd), 0.0)
    )
  end

  @doc """
  Marks a build failed (or `"unsupported"`) and notifies.
  """
  def fail(%Build{} = build, error, log, status \\ "failed") do
    build =
      build
      |> Ecto.Changeset.change(status: status, error: error, log: log || build.log)
      |> Repo.update!()

    notify(%Notification{
      title:
        "#{build.package} #{build.version}: #{if status == "failed", do: "build failed", else: "unsupported"}",
      body: error,
      level: if(status == "failed", do: :warning, else: :info),
      url: admin_url("/builds/#{build.id}"),
      tag: "build-#{build.package}"
    })

    {:ok, build}
  end

  @doc false
  def notify(notification), do: Notifications.notify(notification)

  @doc false
  def admin_url(path) do
    if base = config()[:admin_url], do: base <> "/api/admin" <> path
  end

  ## Setups

  @doc false
  def start_setup(%Build{} = build) do
    Repo.insert!(%Setup{
      package: build.package,
      version: build.version,
      build_id: build.id,
      status: "running",
      model: Playground.Nif.Agent.model()
    })
  end

  @doc """
  Appends a message to a setup, with the usage it adds.
  """
  def record(%Setup{id: id}, message, usage) do
    from(s in Setup, where: s.id == ^id)
    |> Repo.update_all(
      push: [messages: message],
      inc: [
        tool_calls: usage[:tool_calls] || 0,
        input_tokens: usage[:input_tokens] || 0,
        output_tokens: usage[:output_tokens] || 0,
        cost_usd: usage[:cost_usd] || 0.0
      ],
      set: [updated_at: DateTime.utc_now(:second)]
    )
  end

  @doc false
  def finish_setup(%Setup{} = setup, attrs) do
    setup |> Ecto.Changeset.change(attrs) |> Repo.update!()
  end

  @doc """
  Saves the agent's template and the build it made with it.
  """
  def adopt(%Build{} = build, %Setup{} = setup, outcome) do
    {:ok, template} =
      create_template(%{
        "package" => build.package,
        "requirement" => outcome.requirement,
        "recipe" => Recipe.dump(outcome.recipe),
        "origin" => "agent",
        "notes" => outcome.notes,
        "proven_version" => build.version
      })

    build = succeed(build, template, outcome.build)
    finish_setup(setup, status: "succeeded", template_id: template.id, summary: outcome.notes)

    notify(%Notification{
      title: "#{build.package}: new template",
      body: "Built #{build.version}. #{outcome.notes}",
      url: admin_url("/templates/#{template.id}"),
      tag: "template-#{build.package}"
    })

    {:ok, build}
  end

  ## Listing, for the admin API

  def list_builds(filters \\ %{}) do
    Build
    |> where_eq(:package, filters["package"])
    |> where_eq(:status, filters["status"])
    |> order_by([b], desc: b.updated_at, desc: b.id)
    |> limit(200)
    |> Repo.all()
  end

  def list_templates(filters \\ %{}) do
    Template
    |> where_eq(:package, filters["package"])
    |> order_by([t], asc: t.package, desc: t.inserted_at)
    |> Repo.all()
  end

  def list_setups(filters \\ %{}) do
    from(s in Setup, select: %{s | messages: []})
    |> where_eq(:package, filters["package"])
    |> order_by([s], desc: s.inserted_at, desc: s.id)
    |> limit(200)
    |> Repo.all()
  end

  defp where_eq(query, _field, nil), do: query
  defp where_eq(query, field, value), do: where(query, [x], field(x, ^field) == ^value)
end
