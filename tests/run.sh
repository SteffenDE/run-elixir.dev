#!/bin/sh
# Run the playground's browser tests (app/test/e2e, Playwright)
# in Docker, against the built site (python3 -I runtime/build.py),
# which the config serves with runtime/serve.py unless something already
# listens on PORT (8081):
#
#   tests/run.sh [PLAYWRIGHT ARGS...]
#
# e.g. `tests/run.sh --project chromium terminal`. SLOW=1 also
# runs the slow tests; WORKERS sets the parallel workers; HEADSCALE_URL,
# HEADSCALE_API_KEY and HEADSCALE_USER, a Headscale for the Tailscale test
# (docs/tailscale.md). Results and
# traces go to target/tests/. Needs Docker (DOCKER, default
# `sudo -n docker`) and the workspace's node_modules (npm ci at the root).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
mkdir -p "$root/target/tests"
exec ${DOCKER:-sudo -n docker} run --rm --init --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e SLOW="$SLOW" -e WORKERS="$WORKERS" -e PORT="$PORT" -e OUTPUT_DIR=/repo/target/tests \
  -e HEADSCALE_URL="$HEADSCALE_URL" -e HEADSCALE_API_KEY="$HEADSCALE_API_KEY" -e HEADSCALE_USER="$HEADSCALE_USER" \
  -v "$root:/repo" -w /repo/app mcr.microsoft.com/playwright:v1.64.0-noble \
  npx playwright test "$@"
