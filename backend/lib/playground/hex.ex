defmodule Playground.Hex do
  @moduledoc """
  Hex packages, from repo.hex.pm: releases from the registry, tarballs through
  a cache on disk checked against the registry's checksums, unpacked contents.
  (After SCA's Hex modules.)
  """

  require Logger

  @name ~r/\A[a-z][a-z0-9_]*\z/

  @doc """
  Returns whether `name` can be a Hex package's name.
  """
  def valid_name?(name), do: is_binary(name) and Regex.match?(@name, name)

  @doc """
  Returns the package's releases from the registry, by version.
  """
  @spec releases(String.t()) :: {:ok, %{Version.t() => map()}} | {:error, term()}
  def releases(name) do
    if valid_name?(name) do
      case :hex_repo.get_package(:hex_core.default_config(), name) do
        {:ok, {200, _headers, package}} ->
          releases =
            for release <- package.releases,
                {:ok, version} <- [Version.parse(release.version)],
                into: %{},
                do: {version, release}

          {:ok, releases}

        {:ok, {404, _headers, _body}} ->
          {:error, :not_found}

        {:ok, {status, _headers, _body}} ->
          {:error, {:http_status, status}}

        {:error, reason} ->
          {:error, reason}
      end
    else
      {:error, :invalid_name}
    end
  end

  @doc """
  Returns one release: its checksum and dependencies, as the registry has them.
  """
  @spec release(String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def release(name, version) do
    with {:ok, version} <- parse_version(version),
         {:ok, releases} <- releases(name) do
      case Map.fetch(releases, version) do
        {:ok, release} -> {:ok, release}
        :error -> {:error, :not_found}
      end
    end
  end

  @doc """
  Returns how often the package was downloaded, from the Hex API.
  """
  @spec downloads(String.t()) :: {:ok, non_neg_integer()} | {:error, term()}
  def downloads(name) do
    case :hex_api_package.get(:hex_core.default_config(), name) do
      {:ok, {200, _headers, %{"downloads" => downloads}}} -> {:ok, downloads["all"] || 0}
      {:ok, {status, _headers, _body}} -> {:error, {:http_status, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Returns the release's tarball, from the cache or downloaded, as long as it
  has the checksum the registry gives.
  """
  @spec tarball(String.t(), String.t()) :: {:ok, binary()} | {:error, term()}
  def tarball(name, version) do
    with {:ok, release} <- release(name, version) do
      fetch(name, version, release.outer_checksum)
    end
  end

  @doc """
  Unpacks a tarball's contents into `dir` and returns its metadata.
  """
  @spec unpack(binary(), Path.t()) :: {:ok, map()} | {:error, term()}
  def unpack(tarball, dir) do
    File.mkdir_p!(dir)

    case :hex_tarball.unpack(tarball, String.to_charlist(dir)) do
      {:ok, %{metadata: metadata}} -> {:ok, metadata}
      {:error, reason} -> {:error, {:unpack, reason}}
    end
  end

  defp parse_version(version) do
    case Version.parse(version) do
      {:ok, version} -> {:ok, version}
      :error -> {:error, :invalid_version}
    end
  end

  defp fetch(name, version, checksum) do
    path = Path.join(cache_dir(), "#{name}-#{version}.tar")

    case cached(path, checksum) do
      {:ok, tarball} -> {:ok, tarball}
      :error -> download(name, version, checksum, path)
    end
  end

  defp cached(path, checksum) do
    case File.read(path) do
      {:ok, tarball} ->
        if :crypto.hash(:sha256, tarball) == checksum do
          {:ok, tarball}
        else
          Logger.warning("discarding #{Path.basename(path)}, it does not match its checksum")
          _ = File.rm(path)
          :error
        end

      {:error, _reason} ->
        :error
    end
  end

  defp download(name, version, checksum, path) do
    with {:ok, tarball} <- get_tarball(name, version) do
      case :crypto.hash(:sha256, tarball) do
        ^checksum ->
          store(path, tarball)
          {:ok, tarball}

        _actual ->
          {:error, :checksum_mismatch}
      end
    end
  end

  defp get_tarball(name, version) do
    case :hex_repo.get_tarball(:hex_core.default_config(), name, version) do
      {:ok, {200, _headers, tarball}} -> {:ok, tarball}
      {:ok, {status, _headers, _body}} -> {:error, {:http_status, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  # Caching is best effort: the tarball is in memory either way.
  defp store(path, tarball) do
    tmp = "#{path}.#{System.unique_integer([:positive])}"

    with :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(tmp, tarball),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, reason} ->
        Logger.warning("could not cache #{Path.basename(path)}: #{inspect(reason)}")
        _ = File.rm(tmp)
        :ok
    end
  end

  defp cache_dir, do: Path.join(Playground.data_dir(), "hex")
end
