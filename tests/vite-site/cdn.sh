#!/bin/sh
# Bridge mode with a public npm CDN as `content` (docs/api.md, "From a
# public npm CDN"): every package, the runtime too, as published to npm,
# from jsDelivr (its /npm/ layout, which the descriptors' bases name) or
# unpkg (usercontent.packagePath '{name}@{version}/'). Only the api is the
# page's own, from a built site (python3 -I runtime/build.py first), or
# the directory API names. runtime/serve.py is the shared usercontent
# domain (usercontent.localhost:PORT2). Chromium runs `elixir -e` in a
# project of the page's. Needs the network; not in CI.
#
#   tests/vite-site/cdn.sh jsdelivr|unpkg   (PORT: 8095, PORT2: 8096)
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$(dirname "$here")")
port=${PORT:-8095}
bridge=${PORT2:-8096}
# The published versions it runs.
runtime=${RUNTIME:-2.0.0}
otp=otp-29.1.2@${OTP:-1.0.3}
elixir=elixir-1.20.4@${ELIXIR:-2.0.0}
shell=shell@${SHELL_VERSION:-1.0.3}
case $1 in
  jsdelivr)
    content=https://cdn.jsdelivr.net/
    at=https://cdn.jsdelivr.net/npm/@elixir-playground
    layout=
    runtime_path=/npm/@elixir-playground/runtime@$runtime/ ;;
  unpkg)
    content=https://unpkg.com/
    at=https://unpkg.com/@elixir-playground
    layout='&packagePath={name}@{version}/'
    runtime_path=/@elixir-playground/runtime@$runtime/ ;;
  *) echo "usage: $0 jsdelivr|unpkg" >&2; exit 2 ;;
esac
api=${API:-$(ls -d "$root"/target/site/npm/@elixir-playground/api@* | head -1)}
work=$root/target/vite-site-cdn
rm -rf "$work"
mkdir -p "$work/node_modules/@elixir-playground"
ln -s "$api" "$work/node_modules/@elixir-playground/api"
ln -s "$root/node_modules/vite" "$work/node_modules/vite"
echo '{ "type": "module", "private": true }' > "$work/package.json"
cp "$here/cdn/vite.config.js" "$here/cdn/index.html" "$here/cdn/main.js" "$work/"
packages="$at/$otp/index.js,$at/$elixir/index.js,$at/$shell/index.js"
query="content=$content&usercontent=usercontent.localhost:$bridge&runtime=$runtime_path&packages=$packages$layout"
python3 -I "$root/runtime/serve.py" "$bridge" --usercontent "usercontent.localhost:$bridge" >"$work/serve.log" 2>&1 &
serve=$!
cd "$work"
node "$root/node_modules/vite/bin/vite.js" build --logLevel warn
node "$root/node_modules/vite/bin/vite.js" preview --port "$port" --strictPort --host 127.0.0.1 >preview.log 2>&1 &
vite=$!
trap 'kill $serve $vite 2>/dev/null' EXIT
sleep 2
echo "$1 ($content), runtime $runtime, $otp, $elixir, $shell:"
PAGE="http://apex.localhost:$port/?$query" node "$here/check.mjs"
