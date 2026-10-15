defmodule Playground.Nif.RunnerTest do
  use ExUnit.Case, async: true

  alias Playground.Nif.Runner

  @wasm <<0, "asm", 1, 0, 0, 0>>

  test "takes a priv directory with WebAssembly libraries, and writes it anew" do
    tar = tar([{"priv/a_nif.so", @wasm}, {"priv/data.txt", "data"}])

    assert {:ok, library, files} = Runner.library(tar)
    assert files == [{"priv/a_nif.so", 8}, {"priv/data.txt", 4}]

    assert {:ok, [{~c"priv/a_nif.so", @wasm}, {~c"priv/data.txt", "data"}]} =
             :erl_tar.extract({:binary, library}, [:memory])
  end

  test "refuses files outside priv, libraries that aren't WebAssembly, and no library" do
    assert {:error, "the archive has a file outside priv/: lib/x"} =
             Runner.library(tar([{"priv/a.so", @wasm}, {"lib/x", ""}]))

    assert {:error, "the archive has a file outside priv/: priv/../x"} =
             Runner.library(tar([{"priv/../x", ""}]))

    assert {:error, "priv/a.so is not WebAssembly"} =
             Runner.library(tar([{"priv/a.so", <<0x7F, "ELF">>}]))

    assert {:error, "the build made no .so in priv/"} = Runner.library(tar([{"priv/a.txt", ""}]))
    assert {:error, "the output is not a tar archive" <> _} = Runner.library("nope")
  end

  defp tar(files) do
    path = Path.join(System.tmp_dir!(), "runner-test-#{System.unique_integer([:positive])}.tar")
    {:ok, tar} = :erl_tar.open(String.to_charlist(path), [:write])
    for {name, data} <- files, do: :ok = :erl_tar.add(tar, data, String.to_charlist(name), [])
    :ok = :erl_tar.close(tar)
    data = File.read!(path)
    File.rm!(path)
    data
  end
end
