#!/bin/sh
# A tailnet for the Tailscale test (app/test/e2e/tailscale.spec.ts,
# docs/tailscale.md#testing), in Docker on the host's network:
#
#   tests/headscale.sh start   # prints the test's environment
#   tests/headscale.sh stop
#
# Headscale on :8090 with Tailscale's DERP map and the setup's policy
# (tag:elixir-playground may use exit nodes, nothing else), Caddy on :8091
# in front of it adding the CORS header a browser's Tailscale needs on
# /key, and tailscale/tailscale as exit-box, an exit node. On exit-box's
# machine (its tailnet address), an Erlang node, probe@exit-box.tailnet.test
# (cookie playground, distribution on 9100); and on :8093 a probe, which
# asks exit-box to connect into the tailnet (POST /nc?host=ADDRESS&port=P:
# what `tailscale nc` got for the request's body; exit-box resolves no
# MagicDNS names). Beyond the setup's policy,
# the test's: exit-box may reach the playground's port 4000, and the
# playground exit-box's epmd and distribution. Headscale's state goes to
# target/headscale (a fresh tailnet on each start). Needs Docker (DOCKER,
# default `sudo -n docker`), Python 3 and the internet (DERP).
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=$(dirname "$here")/target/headscale
docker=${DOCKER:-sudo -n docker}
HEADSCALE=headscale/headscale:v0.29.5
CADDY=caddy:2
TAILSCALE=tailscale/tailscale:v1.104.1
ERLANG=erlang:28-alpine

stop() {
  $docker rm -f playground-headscale playground-headscale-cors playground-exit-box \
    playground-erlang >/dev/null 2>&1 || true
  if [ -f "$dir/probe.pid" ]; then kill "$(cat "$dir/probe.pid")" 2>/dev/null || true; fi
}

if [ "$1" = stop ]; then
  stop
  exit 0
fi
[ "$1" = start ] || { echo "usage: $0 start|stop" >&2; exit 2; }
stop
rm -rf "$dir"
mkdir -p "$dir/config" "$dir/lib" "$dir/run"

cat >"$dir/config/config.yaml" <<'EOF'
server_url: http://localhost:8090
listen_addr: 0.0.0.0:8090
metrics_listen_addr: 127.0.0.1:9095
grpc_listen_addr: 127.0.0.1:50443
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
policy:
  mode: file
  path: /etc/headscale/policy.json
dns:
  magic_dns: true
  base_domain: tailnet.test
  override_local_dns: false
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
EOF
# The setup's policy (SetupSteps.tsx), but Headscale's tagOwners take
# users, not autogroup:member; and exit-box's routes approved.
cat >"$dir/config/policy.json" <<'EOF'
{
  "tagOwners": {
    "tag:elixir-playground": ["alice@"],
    "tag:exit": ["alice@"]
  },
  "grants": [
    { "src": ["tag:elixir-playground"], "dst": ["autogroup:internet"], "ip": ["*"] },
    { "src": ["tag:exit"], "dst": ["tag:elixir-playground"], "ip": ["tcp:4000"] },
    { "src": ["tag:elixir-playground"], "dst": ["tag:exit"], "ip": ["tcp:4369", "tcp:9100"] }
  ],
  "autoApprovers": { "exitNode": ["tag:exit"] }
}
EOF
cat >"$dir/config/Caddyfile" <<'EOF'
{
	admin off
	auto_https off
}
:8091 {
	header /key Access-Control-Allow-Origin *
	reverse_proxy localhost:8090
}
EOF

$docker run -d --name playground-headscale --network host --user "$(id -u):$(id -g)" \
  -v "$dir/config:/etc/headscale:ro" -v "$dir/lib:/var/lib/headscale" -v "$dir/run:/var/run/headscale" \
  $HEADSCALE serve >/dev/null
$docker run -d --name playground-headscale-cors --network host \
  -v "$dir/config/Caddyfile:/etc/caddy/Caddyfile:ro" $CADDY >/dev/null
hs() { $docker exec playground-headscale headscale "$@"; }
until hs health >/dev/null 2>&1; do sleep 1; done
hs users create alice >/dev/null
key=$(hs preauthkeys create -u 1 --tags tag:exit -o json | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')
api=$(hs apikeys create -e 30d | tail -n 1)
$docker run -d --name playground-exit-box --network host \
  -e TS_AUTHKEY="$key" -e TS_USERSPACE=true -e TS_STATE_DIR=/var/lib/tailscale \
  -e TS_SOCKET=/tmp/tailscaled.sock -e TS_HOSTNAME=exit-box -e TS_TAILSCALED_EXTRA_ARGS=--port=41642 \
  -e TS_EXTRA_ARGS="--login-server=http://localhost:8090 --advertise-exit-node" \
  $TAILSCALE >/dev/null
until $docker exec playground-exit-box tailscale --socket=/tmp/tailscaled.sock status 2>/dev/null | grep -q "offers exit node"; do
  sleep 1
done
$docker run -d --name playground-erlang --network host $ERLANG erl -noshell \
  -name probe@exit-box.tailnet.test -setcookie playground \
  -kernel inet_dist_listen_min 9100 inet_dist_listen_max 9100 -eval 'timer:sleep(infinity)' >/dev/null
until $docker exec playground-erlang epmd -names 2>/dev/null | grep -q "name probe"; do sleep 1; done
cat >"$dir/probe.py" <<'EOF'
import http.server, os, subprocess, urllib.parse
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
class Probe(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        sent = self.rfile.read(int(self.headers.get("content-length", 0)))
        # tailscale nc ends with its input: kept open while the answer comes.
        nc = '(cat; sleep 3) | timeout 20 tailscale --socket=/tmp/tailscaled.sock nc "$0" "$1"'
        got = subprocess.run(DOCKER + ["exec", "-i", "playground-exit-box", "sh", "-c", nc,
                                       query["host"][0], query["port"][0]],
                             input=sent, capture_output=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(got.stdout + got.stderr)
http.server.ThreadingHTTPServer(("127.0.0.1", 8093), Probe).serve_forever()
EOF
DOCKER="$docker" nohup python3 "$dir/probe.py" >"$dir/probe.log" 2>&1 &
echo $! >"$dir/probe.pid"
echo "HEADSCALE_URL=http://localhost:8091 HEADSCALE_API_KEY=$api HEADSCALE_USER=alice"
