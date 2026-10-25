"""Serve the playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, index.html for
paths that are no file (a project's /ID/), Hex's repository at /hex/
(repo.hex.pm sends no CORS headers; app/src/project/lib/hex.ts) and git
clones at /git/HOST/ (app/src/project/lib/programs/git.ts), as Caddy
does in production; and the backend's NIF builds at /api/nif/ and its
sockets at /socket (live sessions' relay, docs/collaboration.md) and
/relay (the TCP relay, docs/relay.md), from
production's unless --api names another backend (http://localhost:4000,
say).

    python3 -I runtime/serve.py [PORT] [--domain DOMAIN] [--usercontent DOMAIN] [--api URL]
        [--embedders "ORIGIN ..."] [--embedder-host HOST --embedder-root DIR]

With --domain and --usercontent (for example playground.localhost:8082
and usercontent.localhost:8082: browsers resolve *.localhost to this
machine, and each is a site of its own), /playground.json names the apex,
which has every page, and the domain whose subdomains run what a
project's code does (app/src/shared/lib/site.ts, docs/frames.md),
whatever the build says. The usercontent domain's hosts are framed by the
apex's pages from another site (Cross-Origin-Resource-Policy:
cross-origin) and open no window of their own isolated; the apex's former
project addresses (p-ID.DOMAIN) send their visitors to the apex.

embed.html, the page another site frames to run a project
(docs/embed.md), may be framed by the origins playground.json names
(`embedders`, or --embedders), and is answered with what lets it be
framed under the embedder's COEP; embed.js, its client, with CORS. With
--embedder-host (embedder.localhost:8081, say) that host is a test
embedder of its own site, serving --embedder-root's files cross-origin
isolated, as an embedder serves its page.
"""
import functools
import http.server
import json
import os
import re
import select
import shutil
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript"}

    # What Hex fetches from its repository, and nothing else.
    HEX = re.compile(r"^/hex/(names|versions|public_key|(packages|tarballs)/[A-Za-z0-9_.+-]+)$")

    def cross_site(self):
        """A browser's request from another site's page: the proxies answer
        the site's own frames and pages, not another site's (a page of
        another site could not read the answer anyway; this keeps the
        proxies from being anyone's through visitors' browsers). Not a
        boundary for other clients, which send what they like."""
        return self.headers.get("Sec-Fetch-Site") == "cross-site"

    def proxy_hex(self, head):
        path = self.HEX.match(self.path.split("?")[0])
        if not path:
            return False
        if self.cross_site():
            self.send_error(403)
            return True
        request = urllib.request.Request("https://repo.hex.pm/" + path.group(1),
                                         method="HEAD" if head else "GET",
                                         headers={"User-Agent": "playground-serve"})
        try:
            upstream = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            upstream = error
        self.send_response(upstream.status)
        for name in ("Content-Type", "Content-Length", "ETag", "Last-Modified", "Cache-Control"):
            if upstream.headers.get(name):
                self.send_header(name, upstream.headers[name])
        self.end_headers()
        if not head:
            shutil.copyfileobj(upstream, self.wfile)
        return True

    # git's smart HTTP, for cloning and fetching only.
    GIT = re.compile(r"^/git/(github\.com|gitlab\.com|codeberg\.org)(/[\w.-]+/[\w.-]+)/(info/refs|git-upload-pack)$")

    def proxy_git(self, method):
        path, _, query = self.path.partition("?")
        match = self.GIT.match(path)
        if not match:
            return False
        host, repo, endpoint = match.groups()
        if self.cross_site() or (method, endpoint, query) not in (("GET", "info/refs", "service=git-upload-pack"),
                                             ("POST", "git-upload-pack", "")):
            self.send_error(403)
            return True
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))) if method == "POST" else None
        headers = {"User-Agent": "git/2.47.0 (playground)"}
        for name in ("Content-Type", "Accept", "Git-Protocol"):
            if self.headers.get(name):
                headers[name] = self.headers[name]
        url = f"https://{host}{repo}/{endpoint}" + (f"?{query}" if query else "")
        try:
            upstream = urllib.request.urlopen(urllib.request.Request(url, data=body, method=method, headers=headers),
                                              timeout=120)
        except urllib.error.HTTPError as error:
            upstream = error
        data = upstream.read()
        self.send_response(upstream.status)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    # The backend's NIF builds (docs/backend.md): its answers as they are.
    API = re.compile(r"^/api/nif/[A-Za-z0-9_]+/[A-Za-z0-9_.+-]+(/library\.tar)?$")

    def proxy_api(self):
        if not self.API.match(self.path.split("?")[0]):
            return False
        if self.cross_site():
            self.send_error(403)
            return True
        request = urllib.request.Request(API + self.path, headers={"User-Agent": "playground-serve"})
        try:
            upstream = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            upstream = error
        except urllib.error.URLError as error:
            self.send_error(502, f"backend: {error.reason}")
            return True
        data = upstream.read()
        self.send_response(upstream.status)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    # The backend's sockets (live sessions, and the TCP relay of exec
    # frames, docs/relay.md): the WebSocket's bytes, both ways, as they are.
    def proxy_socket(self):
        path = self.path.split("?")[0]
        if not (path.startswith("/socket/") or path == "/relay") \
                or self.headers.get("Upgrade", "").lower() != "websocket":
            return False
        upstream = urllib.parse.urlsplit(API)
        port = upstream.port or (443 if upstream.scheme == "https" else 80)
        try:
            conn = socket.create_connection((upstream.hostname, port), timeout=10)
            if upstream.scheme == "https":
                conn = ssl.create_default_context().wrap_socket(conn, server_hostname=upstream.hostname)
        except OSError as error:
            self.send_error(502, f"backend: {error}")
            return True
        conn.settimeout(None)
        head = [f"GET {self.path} HTTP/1.1", f"Host: {upstream.netloc}"]
        head += [f"{name}: {value}" for name, value in self.headers.items() if name.lower() != "host"]
        conn.sendall(("\r\n".join(head) + "\r\n\r\n").encode())
        client = self.connection
        try:
            while True:
                # TLS may hold decrypted bytes select() cannot see.
                pending = [conn] if isinstance(conn, ssl.SSLSocket) and conn.pending() else []
                ready = pending or select.select([client, conn], [], [], 300)[0]
                if not ready:
                    break
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        raise ConnectionError
                    (conn if source is client else client).sendall(data)
        except OSError:
            pass
        finally:
            conn.close()
        self.close_connection = True
        return True

    def do_POST(self):
        if not self.proxy_git("POST"):
            self.send_error(405)

    def do_GET(self):
        if self.embedder():
            super().do_GET()
        elif self.usercontent() and self.path.split("?")[0] == "/embed.html":
            # Only the apex is embedded (docs/embed.md).
            self.send_error(404)
        elif OVERRIDES and self.path.split("?")[0] == "/playground.json":
            data = json.dumps(site_config()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif not self.proxy_socket() and not self.proxy_hex(False) and not self.proxy_git("GET") \
                and not self.proxy_api():
            super().do_GET()

    def do_HEAD(self):
        if not self.proxy_hex(True):
            super().do_HEAD()

    def translate_path(self, path):
        # The test embedder's page and scripts, from their own directory.
        if self.embedder():
            relative = urllib.parse.unquote(path.split("?")[0]).lstrip("/") or "index.html"
            return os.path.join(EMBEDDER_ROOT, os.path.normpath("/" + relative).lstrip("/"))
        return super().translate_path(path)

    def embedder(self):
        host = (self.headers.get("Host") or "").lower()
        return EMBEDDER_HOST is not None and host == EMBEDDER_HOST.lower()

    def send_head(self):
        # The app's routes (/ID/, /phoenix, ...) are the page.
        if not self.embedder() and not os.path.exists(self.translate_path(self.path)):
            self.path = "/index.html"
        return super().send_head()

    def usercontent(self):
        host = (self.headers.get("Host") or "").lower()
        return USERCONTENT is not None and host.endswith("." + USERCONTENT.lower())

    def end_headers(self):
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        path = self.path.split("?")[0]
        if self.embedder():
            # An embedder's own page, cross-origin isolated as it must be;
            # its files (an app's archive) fetched by the project's frame,
            # another site: with CORS.
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Access-Control-Allow-Origin", "*")
        elif path == "/embed.html":
            # Framed by an embedder's page, another site, under its COEP;
            # by those the site names alone.
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            ancestors = " ".join(site_config().get("embedders") or []) or "'none'"
            self.send_header("Content-Security-Policy", f"frame-ancestors {ancestors}")
        elif path == "/embed.js":
            # The client, which an embedder's page imports (a module: CORS).
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            self.send_header("Access-Control-Allow-Origin", "*")
        elif self.usercontent():
            # The apex's pages frame these from another site.
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        else:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            # A project's origin and the apex frame each other (the same site).
            self.send_header("Cross-Origin-Resource-Policy", "same-site")
        node = NODE_SCRIPT.match(self.path.split("?")[0])
        if node:
            self.send_header("Content-Security-Policy",
                             node_policy("http://" + (self.headers.get("Host") or ""), node.group(1)))
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


# A Node.js process's worker (nodejs.js) and the chunks it imports.
NODE_SCRIPT = re.compile(r"^/b/([^/]+)/(?:nodejs\.js|chunks/[^/]+\.js)$")


def node_policy(origin, build):
    """A Node.js process's worker's policy (docs/nodejs.md, The worker's
    policy), as Caddy sends it: its own scripts (a module worker's imports
    are worker scripts too) and the runtime's files (/r/: tls.wasm,
    roots.pem), eval and WebAssembly, and threads from blobs, which inherit
    it. No other network: a script reaches other hosts only by the
    process's messages. Its chunks carry it too, so a worker started from
    one of them is held the same."""
    scripts = f"{origin}/b/{build}/nodejs.js {origin}/b/{build}/chunks/"
    return (f"default-src 'none'; script-src {scripts} 'unsafe-eval' 'wasm-unsafe-eval'; "
            f"worker-src {scripts} blob:; connect-src {origin}/r/ data: blob:")


def site_config():
    """playground.json as served: the site's, with what the command line
    names instead."""
    try:
        with open(os.path.join(directory, "playground.json")) as f:
            config = json.load(f)
    except (OSError, ValueError):
        config = {}
    return {**config, **OVERRIDES}


directory = os.path.join(ROOT, "target", "site")
args = sys.argv[1:]
OPTIONS = ("--domain", "--usercontent", "--api", "--embedders", "--embedder-host", "--embedder-root")
option = lambda name: args[args.index(name) + 1] if name in args else None
DOMAIN = option("--domain")
USERCONTENT = option("--usercontent")
EMBEDDERS = option("--embedders")
EMBEDDER_HOST = option("--embedder-host")
EMBEDDER_ROOT = os.path.abspath(option("--embedder-root") or ".")
OVERRIDES = {key: value for key, value in (("domain", DOMAIN), ("usercontent", USERCONTENT),
                                           ("embedders", EMBEDDERS and EMBEDDERS.split()))
             if value is not None}
API = (args[args.index("--api") + 1] if "--api" in args else "https://run-elixir.dev").rstrip("/")
args = [arg for i, arg in enumerate(args)
        if arg not in OPTIONS and (i == 0 or args[i - 1] not in OPTIONS)]
port = int(args[0]) if args else 8080
print(f"http://localhost:{port}/ serving {directory}, NIF builds and live sessions from {API}")
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=directory)).serve_forever()
