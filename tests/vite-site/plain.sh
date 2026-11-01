#!/bin/sh
# A site that does not use @elixir-playground/vite (docs/api.md, "A site
# without the Vite plugin"), against a built site's packages (python3 -I
# runtime/build.py first): plain/ is a Vite app that installs the api and a
# few descriptors (links to the laid-out packages) and bundles them as it
# bundles any dependency. runtime/serve.py is the CDN on another origin
# (cdn.localhost:PORT2: the packages at /npm/…, with CORS) and the shared
# usercontent domain (usercontent.localhost:PORT2). The page names neither
# usercontent.worker nor a layout of the plugin's: the apex worker is
# where Vite put it. Chromium runs `elixir -e` in a project of the page's,
# after `vite build` (vite preview) and on the dev server (`vite`, with
# the api pre-bundled as Vite does by default).
#
#   tests/vite-site/plain.sh          (PORT: 8097, PORT2: 8098)
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$(dirname "$here")")
port=${PORT:-8097}
cdn=${PORT2:-8098}
site=$root/target/site/npm/@elixir-playground
work=$root/target/vite-site-plain
rm -rf "$work"
mkdir -p "$work/node_modules/@elixir-playground"
for name in api runtime otp-29.1.2 elixir-1.20.4 shell; do
  ln -s "$(ls -d "$site/$name"@* | head -1)" "$work/node_modules/@elixir-playground/$name"
done
ln -s "$root/node_modules/vite" "$work/node_modules/vite"
echo '{ "type": "module", "private": true }' > "$work/package.json"
cp "$here/plain/vite.config.js" "$here/plain/index.html" "$here/plain/main.js" "$work/"
runtime=$(cd "$site" && ls -d runtime@* | sed 's/+.*//')
query="content=http://cdn.localhost:$cdn/&usercontent=usercontent.localhost:$cdn&runtime=/npm/@elixir-playground/$runtime/"
python3 -I "$root/runtime/serve.py" "$cdn" --usercontent "usercontent.localhost:$cdn" >"$work/serve.log" 2>&1 &
serve=$!
cd "$work"
node "$root/node_modules/vite/bin/vite.js" build --logLevel warn
ls dist/assets | grep -q '^apexWorker' || { echo "vite build emitted no apexWorker"; kill $serve; exit 1; }
node "$root/node_modules/vite/bin/vite.js" preview --port "$port" --strictPort --host 127.0.0.1 >preview.log 2>&1 &
vite=$!
trap 'kill $serve $vite 2>/dev/null' EXIT
sleep 2
echo "vite build + preview:"
PAGE="http://apex.localhost:$port/?$query" node "$here/check.mjs"
kill $vite
wait $vite 2>/dev/null || true
node "$root/node_modules/vite/bin/vite.js" --port "$port" --strictPort --host 127.0.0.1 >dev.log 2>&1 &
vite=$!
sleep 2
echo "vite (dev server):"
PAGE="http://apex.localhost:$port/?$query" node "$here/check.mjs"
