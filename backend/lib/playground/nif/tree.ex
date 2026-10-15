defmodule Playground.Nif.Tree do
  @moduledoc """
  A release's files, as the agent reads them: from memory, a path is only
  ever a key of `files`. (After SCA's `SCA.AI.Tree`.)
  """

  defstruct [:name, :version, :files, :metadata]

  @type t :: %__MODULE__{
          name: String.t(),
          version: String.t(),
          files: %{String.t() => binary()},
          metadata: map()
        }

  @search_matches 30
  @search_context 80

  @doc """
  Loads a release's files from its Hex tarball.
  """
  def load(name, version) do
    with {:ok, tarball} <- Playground.Hex.tarball(name, version),
         {:ok, %{contents: contents, metadata: metadata}} <-
           :hex_tarball.unpack(tarball, :memory) do
      files = Map.new(contents, fn {path, data} -> {List.to_string(path), data} end)
      {:ok, %__MODULE__{name: name, version: version, files: files, metadata: metadata}}
    end
  end

  @doc """
  Returns the paths and sizes of the files, sorted.
  """
  def listing(%__MODULE__{files: files}) do
    files |> Enum.map(fn {path, data} -> {path, byte_size(data)} end) |> Enum.sort()
  end

  @doc """
  Returns `length` bytes of a file from `offset`, as valid UTF-8.
  """
  def read(%__MODULE__{files: files}, path, offset, length) do
    case Map.fetch(files, path) do
      {:ok, data} ->
        size = byte_size(data)
        offset = offset |> max(0) |> min(size)
        length = length |> max(0) |> min(size - offset)
        next = offset + length

        {:ok,
         %{
           content: data |> binary_part(offset, length) |> text(),
           size: size,
           offset: offset,
           next_offset: if(next < size, do: next)
         }}

      :error ->
        {:error, :not_found}
    end
  end

  @doc """
  Finds `text` in a file, or in every file when `path` is `nil`, and returns
  where, with some context around each match.
  """
  def search(%__MODULE__{files: files}, path, text) when text != "" do
    files =
      case path do
        nil -> {:ok, Enum.sort(files)}
        path -> if data = files[path], do: {:ok, [{path, data}]}, else: {:error, :not_found}
      end

    with {:ok, files} <- files do
      matches =
        files
        |> Stream.flat_map(fn {path, data} ->
          for {offset, length} <- :binary.matches(data, text) do
            from = max(offset - @search_context, 0)
            to = min(offset + length + @search_context, byte_size(data))
            %{path: path, offset: offset, context: data |> binary_part(from, to - from) |> text()}
          end
        end)
        |> Enum.take(@search_matches + 1)

      {:ok, Enum.take(matches, @search_matches), length(matches) > @search_matches}
    end
  end

  def search(_tree, _path, ""), do: {:error, :empty}

  @doc """
  Makes text a model can read and Postgres can store.
  """
  def text(nil), do: nil
  def text(string), do: string |> String.replace_invalid() |> String.replace(<<0>>, "�")
end
