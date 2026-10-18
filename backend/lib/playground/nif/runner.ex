defmodule Playground.Nif.Runner do
  @moduledoc """
  Builds a package version with a recipe in a sandbox VM.

  The workspace holds the package's sources (`src/`), the recipe
  (`recipe.sh`) and `build.sh`,
  which runs it in `src/` with its output on stderr, then writes the app's
  `priv` directory to stdout as a tar archive. So stderr is the build's log.

  What comes back is checked before anyone gets it: regular files under
  `priv/` only, and at least one `.so`, all of them WebAssembly. The archive
  is written anew from those files (`ustar`, as nif/build.py's),
  which the playground's `make` unpacks into the app's directory.
  """

  alias Playground.Hex
  alias Playground.Nif.Recipe
  alias Playground.Sandbox

  @build_sh """
  mkdir -p "$APP"
  cd "$SRC"
  sh -eu /workspace/recipe.sh >&2
  if [ ! -d "$APP/priv" ]; then
    echo "build.sh: the recipe left no $APP/priv" >&2
    exit 3
  fi
  tar -cf - -C "$APP" priv
  """

  @max_library 64 * 1024 * 1024
  @log_tail 65_536

  @type success :: %{
          app: String.t(),
          tar: binary(),
          files: [{String.t(), non_neg_integer()}],
          log: String.t(),
          duration_ms: non_neg_integer()
        }

  @type failure :: %{reason: String.t(), log: String.t(), duration_ms: non_neg_integer()}

  @doc """
  Builds `name`-`version` with the recipe.
  """
  @spec run(String.t(), String.t(), Recipe.t(), keyword()) ::
          {:ok, success()} | {:error, failure()}
  def run(name, version, %Recipe{} = recipe, opts \\ []) do
    dir = Path.join(System.tmp_dir!(), "nif-build-#{System.unique_integer([:positive])}")

    try do
      with {:ok, app, archive} <- workspace(dir, name, version, recipe) do
        job = %Sandbox.Job{
          command: ["sh", "-eu", "/workspace/build.sh"],
          environment: environment(name, version),
          workspace_archive: archive,
          network: if(recipe.allowed_hosts == [], do: :none, else: :mediated),
          allowed_hosts: recipe.allowed_hosts,
          timeout: to_timeout(minute: recipe.timeout_minutes),
          cpus: config(:cpus, 2),
          memory_mib: config(:memory_mib, 4096),
          max_output: @max_library
        }

        case Sandbox.run(job, opts) do
          {:ok, result} -> outcome(app, result)
          {:error, reason} -> failure("the VM did not start: #{inspect(reason)}", "", 0)
        end
      else
        {:error, reason} -> failure("preparing the workspace failed: #{inspect(reason)}", "", 0)
      end
    after
      File.rm_rf(dir)
    end
  end

  defp environment(name, version) do
    %{
      "SRC" => "/workspace/src",
      "APP" => "/workspace/app",
      "PKG_NAME" => name,
      "PKG_VERSION" => version,
      "CC" => "/tools/nifcc",
      "CXX" => "/tools/nifc++",
      "CFLAGS" => "-O2",
      "CXXFLAGS" => "-O2",
      "ERTS_INCLUDE_DIR" => "/nif/include",
      "MIX_APP_PATH" => "/workspace/app",
      "MIX_ENV" => "prod",
      "MIX_TARGET" => "host",
      "CROSSCOMPILE" => "wasm32-wasip1"
    }
  end

  @doc """
  Writes the workspace archive into `dir` and returns the package's app name
  and the archive's path.
  """
  def workspace(dir, name, version, recipe) do
    root = Path.join(dir, "workspace")

    with {:ok, tarball} <- Hex.tarball(name, version),
         {:ok, metadata} <- Hex.unpack(tarball, Path.join(root, "src")) do
      File.write!(Path.join(root, "build.sh"), @build_sh)
      File.write!(Path.join(root, "recipe.sh"), recipe.script)

      archive = Path.join(dir, "workspace.tar.gz")
      :ok = :erl_tar.create(String.to_charlist(archive), entries(root), [:compressed])

      {:ok, Map.get(metadata, "app", name), archive}
    end
  end

  defp entries(root) do
    for path <- Path.wildcard(Path.join(root, "**"), match_dot: true), File.regular?(path) do
      {path |> Path.relative_to(root) |> String.to_charlist(), String.to_charlist(path)}
    end
  end

  defp outcome(app, %Sandbox.Result{status: :exited, exit_status: 0} = result) do
    log = tail(result.stderr)

    cond do
      result.output_truncated? ->
        failure("the output was larger than #{div(@max_library, 1024 * 1024)} MiB", log, result)

      true ->
        case library(result.stdout) do
          {:ok, tar, files} ->
            {:ok, %{app: app, tar: tar, files: files, log: log, duration_ms: result.duration_ms}}

          {:error, reason} ->
            failure(reason, log, result)
        end
    end
  end

  defp outcome(_app, %Sandbox.Result{status: :exited} = result),
    do: failure("the build exited with status #{result.exit_status}", tail(result.stderr), result)

  defp outcome(_app, %Sandbox.Result{status: :timeout} = result),
    do: failure("the build timed out", tail(result.stderr), result)

  defp outcome(_app, %Sandbox.Result{} = result) do
    log = tail(result.stderr) <> "\n--- system log ---\n" <> tail(result.system_log)
    failure("the VM #{result.status}", log, result)
  end

  defp failure(reason, log, %Sandbox.Result{} = result),
    do: failure(reason, log, result.duration_ms) |> network(result)

  defp failure(reason, log, duration_ms),
    do: {:error, %{reason: reason, log: log, duration_ms: duration_ms}}

  # Connections that were refused say why the build could not fetch something.
  defp network({:error, failure}, %Sandbox.Result{connections: connections}) do
    refused =
      for %{error: error} = connection <- connections, error != nil do
        "#{connection.host}:#{connection.port} (#{inspect(error)})"
      end

    if refused == [] do
      {:error, failure}
    else
      {:error,
       %{
         failure
         | log: failure.log <> "\n--- refused connections ---\n" <> Enum.join(refused, "\n")
       }}
    end
  end

  @doc """
  Checks the archive the build wrote and writes it anew; returns it with its
  files and their sizes.
  """
  def library(tar) do
    case :erl_tar.extract({:binary, tar}, [:memory]) do
      {:ok, files} ->
        files = for {name, content} <- files, do: {List.to_string(name), content}

        cond do
          bad = Enum.find(files, fn {name, _} -> not safe?(name) end) ->
            {:error, "the archive has a file outside priv/: #{elem(bad, 0)}"}

          not Enum.any?(files, fn {name, _} -> String.ends_with?(name, ".so") end) ->
            {:error, "the build made no .so in priv/"}

          bad = Enum.find(files, &not_wasm?/1) ->
            {:error, "#{elem(bad, 0)} is not WebAssembly"}

          true ->
            {:ok, ustar(files),
             Enum.map(files, fn {name, content} -> {name, byte_size(content)} end)}
        end

      {:error, reason} ->
        {:error, "the output is not a tar archive: #{inspect(reason)}"}
    end
  end

  defp safe?(name) do
    parts = Path.split(name)
    match?(["priv" | _], parts) and ".." not in parts and Path.type(name) == :relative
  end

  defp not_wasm?({name, content}),
    do: String.ends_with?(name, ".so") and not match?(<<0, "asm", _::binary>>, content)

  defp ustar(files) do
    dir = Path.join(System.tmp_dir!(), "nif-library-#{System.unique_integer([:positive])}")
    path = Path.join(dir, "library.tar")

    try do
      File.mkdir_p!(dir)
      {:ok, tar} = :erl_tar.open(String.to_charlist(path), [:write])

      for {name, content} <- Enum.sort(files) do
        :ok = :erl_tar.add(tar, content, String.to_charlist(name), [])
      end

      :ok = :erl_tar.close(tar)
      File.read!(path)
    after
      File.rm_rf(dir)
    end
  end

  defp tail(text) when byte_size(text) <= @log_tail, do: scrub(text)

  defp tail(text),
    do: "…\n" <> scrub(binary_part(text, byte_size(text) - @log_tail, @log_tail))

  # Logs go into the database and to the model as text.
  defp scrub(text) do
    if String.valid?(text), do: text, else: :unicode.characters_to_binary(text, :latin1)
  end

  defp config(key, default),
    do: Application.get_env(:playground, Playground.Nif, [])[key] || default
end
