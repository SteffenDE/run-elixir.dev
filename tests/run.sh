#!/bin/sh
# Run the playground's browser tests (playground/app/test/e2e, Playwright)
# in Docker, against the built site (python3 -I playground/runtime/build.py),
# which the config serves with runtime/serve.py unless something already
# listens on PORT (8081):
#
#   playground/tests/run.sh [PLAYWRIGHT ARGS...]
#
# e.g. `playground/tests/run.sh --project chromium terminal`. SLOW=1 also
# runs the slow tests; WORKERS sets the parallel workers. Results and
# traces go to target/playground-tests/. Needs Docker (DOCKER, default
# `sudo -n docker`) and the app's node_modules (npm ci in playground/app).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$(dirname "$here")")
mkdir -p "$root/target/playground-tests"
exec ${DOCKER:-sudo -n docker} run --rm --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e SLOW -e WORKERS -e PORT -e OUTPUT_DIR=/repo/target/playground-tests \
  -v "$root:/repo" -w /repo/playground/app mcr.microsoft.com/playwright:v1.55.0-noble \
  npx playwright test "$@"
