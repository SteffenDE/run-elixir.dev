#!/bin/sh
# A site built with @elixir-playground/vite (docs/api.md), against a built
# site's packages (python3 -I runtime/build.py first): the fixture here
# installs them in target/vite-site/node_modules (links to the laid-out
# packages, as npm would install the published ones), `vite build` lays
# the packages out in the site's own dist/ (below Vite's base /web/: at
# /web/npm/…), `vite preview` serves both the apex (apex.localhost:PORT)
# and the shared usercontent domain's hosts (usercontent.localhost:PORT,
# docs/frames.md), and Chromium runs `elixir -e` in a project of the page's.
#
#   tests/vite-site/run.sh            (PORT: 8099)
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$(dirname "$here")")
port=${PORT:-8099}
site=$root/target/site/npm/@elixir-playground
work=$root/target/vite-site
rm -rf "$work"
mkdir -p "$work/node_modules/@elixir-playground" "$work/node_modules/@electric-sql"
for package in "$site"/*; do
  name=$(basename "$package")
  case $name in
    phoenix-template@*|tailscale@*) ;;  # the playground's own
    # Copied, without the site's prepared builds: its prepare imports the
    # runtime's harness from beside it, as installed (Node resolves a
    # link's imports from its target), and the plugin prepares the build.
    elixir@*) mkdir "$work/node_modules/@elixir-playground/elixir"
      (cd "$package" && tar -cf - --exclude=./versions .) | tar -xf - -C "$work/node_modules/@elixir-playground/elixir" ;;
    *) ln -s "$package" "$work/node_modules/@elixir-playground/${name%%@*}" ;;
  esac
done
ln -s "$root/node_modules/@electric-sql/pglite" "$work/node_modules/@electric-sql/pglite"
ln -s "$root/node_modules/vite" "$work/node_modules/vite"
echo '{ "type": "module", "private": true }' > "$work/package.json"
sed "s/8099/$port/g" "$here/vite.config.js" > "$work/vite.config.js"
cp "$here/index.html" "$here/main.js" "$work/"
cd "$work"
node "$root/node_modules/vite/bin/vite.js" build --logLevel warn
node "$root/node_modules/vite/bin/vite.js" preview --port "$port" --strictPort --host 127.0.0.1 >preview.log 2>&1 &
preview=$!
trap 'kill $preview' EXIT
sleep 2
PORT=$port node "$here/check.mjs"
