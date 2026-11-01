#!/bin/sh
# An app as an embedder builds it for run-elixir.dev (docs/api.md):
# `mix phx.new` with Tidewave, its deps fetched and compiled natively with
# the runtime's OTP and Elixir (runtime.json's: hexpm/elixir's image of
# them, in Docker) at the path it has in the playground, /work/demo (Mix
# records the app's absolute path: elsewhere, its own sources compile
# again), its assets built, and tarred with deps/ and _build/ but the
# native esbuild and tailwind (the playground has its own) and git
# dependencies' history. embed.spec.ts's archive test boots it from
# app/test/embedder/archives/demo.tar.gz, which the test embedder serves.
#
#   tests/embed-archive.sh
#   tests/embed-archive.sh --native
#
# Needs Docker (DOCKER, default `sudo -n docker`) and the network. With
# --native, no Docker: the host's OTP and Elixir, which must be exactly
# the runtime's (checked), and its git. It builds in WORK (default /work,
# which must exist and be writable): below another path, the app's own
# sources compile again in the playground. Mix's and Hex's homes are
# scratch directories, so the host's own archives stay as they are.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
otp=29.1.2
elixir=1.20.4
image=hexpm/elixir:$elixir-erlang-$otp-debian-bookworm-20261020
work=$root/target/embed-archive
out=$root/app/test/embedder/archives
rm -rf "$work"
mkdir -p "$work" "$out"
cat > "$work/build.sh" <<'SCRIPT'
set -e
mix local.hex --force
mix local.rebar --force
mix archive.install hex phx_new 1.8.15 --force
cd "${WORK:-/work}"
printf 'n\n' | mix phx.new demo --no-install
cd demo
# Tidewave, and its plug in the endpoint (as its README says).
sed -i 's/{:bandit, "~> 1.5"}/{:bandit, "~> 1.5"},\n      {:tidewave, "~> 0.9", only: :dev}/' mix.exs
sed -i 's/^  if code_reloading? do$/  if Code.ensure_loaded?(Tidewave) do\n    plug Tidewave\n  end\n\n  if code_reloading? do/' lib/demo_web/endpoint.ex
# PGlite in the browser is one session, and its one database "postgres".
cat >> config/dev.exs <<'EOF'

# run-elixir.dev: PGlite in the browser is one session.
config :demo, Demo.Repo, database: "postgres", pool_size: 1
EOF
mix deps.get
mix assets.setup
mix assets.build
mix compile
# A git dependency's repository without its objects, as the template's
# (runtime/build.py app_files): config, HEAD and refs, and an empty
# objects/info/packs, all Mix's lock check reads (daisyui's history alone
# is 70 MB).
for git in deps/*/.git; do
  [ -d "$git" ] || continue
  find "$git" -mindepth 1 -maxdepth 1 ! -name config ! -name HEAD ! -name packed-refs ! -name refs \
    -exec rm -rf {} +
  mkdir -p "$git/objects/info"
  : > "$git/objects/info/packs"
done
cd "${WORK:-/work}"
tar czf demo.tar.gz --exclude='demo/_build/esbuild-*' --exclude='demo/_build/tailwind-*' \
  --exclude='demo/assets/node_modules' demo
SCRIPT
if [ "$1" = --native ]; then
  host_otp=$(erl -noshell -eval 'io:format("~s", [string:trim(element(2, file:read_file(filename:join([code:root_dir(), "releases", erlang:system_info(otp_release), "OTP_VERSION"]))))]), halt().')
  host_elixir=$(elixir -e 'IO.write(System.version())')
  if [ "$host_otp" != $otp ] || [ "$host_elixir" != $elixir ]; then
    echo "--native needs OTP $otp and Elixir $elixir; the host has OTP $host_otp and Elixir $host_elixir" >&2
    exit 1
  fi
  native=${WORK:-/work}
  if [ ! -w "$native" ]; then
    echo "--native builds in $native (the app's path in the playground): create it, writable, or set WORK" >&2
    exit 1
  fi
  rm -rf "$native/demo" "$native/demo.tar.gz"
  mkdir -p "$work/home"
  HOME=$work/home MIX_HOME=$work/home/mix HEX_HOME=$work/home/hex WORK=$native sh "$work/build.sh"
  mv "$native/demo.tar.gz" "$out/demo.tar.gz"
  ls -la "$out/demo.tar.gz"
  exit 0
fi
# git for Mix's git dependencies (the image has none), then the build as
# this user.
${DOCKER:-sudo -n docker} run --rm --network host -e HOME=/tmp/home -v "$work:/work" -w /work "$image" \
  sh -c "apt-get update -qq && apt-get install -qq -y git >/dev/null && mkdir -p /tmp/home &&
    chown $(id -u):$(id -g) /tmp/home && setpriv --reuid=$(id -u) --regid=$(id -g) --clear-groups sh /work/build.sh"
mv "$work/demo.tar.gz" "$out/demo.tar.gz"
ls -la "$out/demo.tar.gz"
