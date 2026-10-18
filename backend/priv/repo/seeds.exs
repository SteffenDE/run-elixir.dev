# The templates of nif/build.py's recipes, for the packages the
# site builds itself. Run again, it leaves templates that exist alone.
#
#     mix run priv/repo/seeds.exs

import Ecto.Query

alias Playground.Repo
alias Playground.Nif.Template

seeds = [
  %{
    "package" => "bcrypt_elixir",
    "proven_version" => "3.3.2",
    "notes" => "make all (its make_targets).",
    "recipe" => %{"script" => "make all"}
  },
  %{
    "package" => "argon2_elixir",
    "proven_version" => "4.1.3",
    "notes" =>
      "Argon2's reference code runs its lanes in threads, which the layer does not have: " <>
        "without them, one after another.",
    "recipe" => %{"script" => ~s(CFLAGS="-O2 -DARGON2_NO_THREADS" make all)}
  },
  %{
    "package" => "picosat_elixir",
    "proven_version" => "0.2.3",
    "notes" =>
      "Its Makefile builds into $(MIX_BUILD_PATH)/lib/picosat_elixir/priv: that is the " <>
        "app's directory here. Without getrusage (WASI has no process clocks): its " <>
        "statistics only; its NIF includes signal.h and uses nothing of it.",
    "recipe" => %{
      "script" => """
      mkdir -p "$SRC/_mix_build/lib" && ln -s "$APP" "$SRC/_mix_build/lib/$PKG_NAME"
      MIX_BUILD_PATH="$SRC/_mix_build" CC="/tools/nifcc -DNGETRUSAGE -D_WASI_EMULATED_SIGNAL" make all\
      """
    }
  },
  %{
    "package" => "lazy_html",
    "proven_version" => "0.1.13",
    "notes" =>
      "lexbor at the commit mix.exs names, from GitHub's archive, built with the wasi-sdk " <>
        "CMake toolchain where the Makefile looks for it (it would clone and build it for " <>
        "the host); Fine's headers from mix deps.get.",
    "recipe" => %{
      "script" => Playground.Nif.Agent.lazy_html_script(),
      "allowed_hosts" => ["repo.hex.pm", "codeload.github.com"]
    }
  }
]

for seed <- seeds do
  unless Repo.exists?(from t in Template, where: t.package == ^seed["package"]) do
    {:ok, _template} = Playground.Nif.create_template(Map.put(seed, "origin", "seed"))
  end
end
