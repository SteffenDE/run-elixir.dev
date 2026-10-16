# Compile a dependency's lib/ the way `mix deps.compile NAME --force` does
# (Kernel.ParallelCompiler over its .ex files), without Mix or Hex, so the
# same run works on BEAM, Rust-OTP and the Emscripten BEAM.
#
#   cd PROJECT && elixir -pa ELIXIR_ROOT/mix/ebin bench_ash.exs [NAME] [BUILD_ROOT]
#
# Every other dependency's ebin under BUILD_ROOT/dev/lib (default _build) is
# on the code path; the output goes to a temporary directory.
[name, build] =
  case System.argv() do
    [] -> ["ash", "_build"]
    [name] -> [name, "_build"]
    [name, build] -> [name, build]
  end

for ebin <- Path.wildcard(Path.join(build, "dev/lib/*/ebin")),
    Path.basename(Path.dirname(ebin)) != name do
  Code.prepend_path(ebin)
end

# Mix tasks among the sources ask Mix's project stack at compile time.
Mix.start()

files = Path.wildcard("deps/#{name}/lib/**/*.ex")
out = Path.join(System.tmp_dir!(), "bench-#{name}-#{System.unique_integer([:positive])}")
File.mkdir_p!(out)

{micros, {:ok, modules, _}} =
  :timer.tc(fn ->
    Kernel.ParallelCompiler.compile_to_path(files, out, return_diagnostics: true)
  end)

IO.puts(
  "#{name}: #{length(files)} files, #{length(modules)} modules in " <>
    "#{Float.round(micros / 1_000_000, 1)} s on #{:erlang.system_info(:schedulers_online)} schedulers"
)

File.rm_rf!(out)
