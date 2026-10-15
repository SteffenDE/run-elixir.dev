defmodule PlaygroundWeb.NifController do
  @moduledoc """
  A package version's NIF library, for the playground's `make`.

  `GET /api/nif/:package/:version` answers the build's status, queueing it
  when there is none: 200 with `url` once it succeeded, 202 while it is
  queued, running or being set up (ask again), 422 when it failed or there
  is nothing to build (`error` says why), 404 for a version Hex does not
  have. `url` is a path: the page asks on its own origin, through the proxy. `GET .../library.tar` is the library's archive: the app's `priv`
  files, which `make` unpacks into the app's directory.
  """

  use PlaygroundWeb, :controller

  alias Playground.Nif

  def show(conn, %{"package" => package, "version" => version}) do
    case Nif.request(package, version) do
      {:ok, build} ->
        conn |> put_status(status(build.status)) |> json(describe(build))

      {:error, reason} when reason in [:not_found, :invalid_name, :invalid_version] ->
        conn |> put_status(404) |> json(%{error: "#{package} #{version} is not on Hex"})

      {:error, reason} ->
        conn |> put_status(502) |> json(%{error: "Hex: #{inspect(reason)}"})
    end
  end

  def library(conn, %{"package" => package, "version" => version}) do
    case Playground.Repo.get_by(Nif.Build,
           package: package,
           version: version,
           toolchain: Nif.toolchain(),
           status: "succeeded"
         ) do
      nil ->
        conn |> put_status(404) |> json(%{error: "not built"})

      build ->
        conn
        |> put_resp_content_type("application/x-tar", nil)
        |> put_resp_header("cache-control", "public, max-age=31536000, immutable")
        |> put_resp_header("etag", ~s("#{build.sha256}"))
        |> send_file(200, Nif.artifact_path(build))
    end
  end

  defp status("succeeded"), do: 200
  defp status(status) when status in ["failed", "unsupported"], do: 422
  defp status(_pending), do: 202

  defp describe(build) do
    base = %{package: build.package, version: build.version, status: build.status}

    case build.status do
      "succeeded" ->
        Map.merge(base, %{
          app: build.app,
          sha256: build.sha256,
          size: build.size,
          url: ~p"/api/nif/#{build.package}/#{build.version}/library.tar"
        })

      status when status in ["failed", "unsupported"] ->
        Map.put(base, :error, build.error)

      _pending ->
        base
    end
  end
end
