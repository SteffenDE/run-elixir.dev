# A NIF package for the playground's tests (tests/nif/build.py builds it to
# WebAssembly; the e2e tests add it to a project as a path dependency).
defmodule NifFixture.MixProject do
  use Mix.Project

  def project do
    [
      app: :nif_fixture,
      version: "0.1.0",
      elixir: "~> 1.18",
      compilers: [:elixir_make] ++ Mix.compilers(),
      make_targets: ["all"],
      deps: [{:elixir_make, "~> 0.9", runtime: false}]
    ]
  end

  def application, do: []
end
