#!/bin/sh
# Run a Playwright browser test against a served playground site:
#
#   playground/tests/run.sh SCRIPT URL [ARGS...]
#
# e.g. playground/tests/run.sh edit.mjs http://localhost:8081/ after
# `python3 -I playground/runtime/serve.py phoenix 8081`. BROWSER=firefox
# runs Firefox; SCHEME=dark the dark colour scheme. Screenshots go to
# target/playground-tests/. Needs Docker (DOCKER, default `sudo -n docker`).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$(dirname "$here")")
out=$root/target/playground-tests
mkdir -p "$out"
script=$1
shift
${DOCKER:-sudo -n docker} run --rm --network host -e BROWSER="$BROWSER" -e SCHEME="$SCHEME" \
  -v "$here:/t:ro" -v "$out:/out" mcr.microsoft.com/playwright:v1.55.0-noble \
  sh -c "cd /tmp && npm i -s playwright@1.55.0 >/dev/null 2>&1 && cp /t/$script . && node $script \"\$@\"" sh "$@"
