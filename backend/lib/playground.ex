defmodule Playground do
  @moduledoc """
  The Elixir Playground's backend: builds NIF libraries to WebAssembly on
  request (`Playground.Nif`), in Firecracker VMs (`Playground.Sandbox`).
  """

  @doc """
  Returns the directory kept across deploys: Hex tarballs and built
  libraries. `PLAYGROUND_DATA_DIR`, or `tmp/data` in the project.
  """
  def data_dir do
    Application.get_env(:playground, :data_dir) ||
      Path.expand("../tmp/data", __DIR__)
  end
end
