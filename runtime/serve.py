"""Serve the playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, index.html for
paths that are no file (a project's /ID/), Hex's repository at /hex/
(repo.hex.pm sends no CORS headers; packages/runtime/src/hex.ts) and git
clones at /git/HOST/ (packages/runtime/src/programs/git.ts), as Caddy
does in production; and the backend's NIF builds at /api/v1/nif/ and its
sockets at /socket (live sessions' relay, docs/collaboration.md) and
/relay (the TCP relay, docs/relay.md), from
production's unless --api names another backend (http://localhost:4000,
say). With --nif DIR, NIF builds are DIR's instead, as the backend would
answer for them (DIR/libraries/ABI/NAME-VERSION.tar: tests/nif/build.py's
target/test-nif), and no other is built.

    python3 -I runtime/serve.py [PORT] [--domain DOMAIN] [--usercontent DOMAIN] [--api URL]
        [--nif DIR] [--embedders "ORIGIN ..."] [--embedder-host HOST --embedder-root DIR]
        [--bridge DOMAIN] [--immutable]

With --domain and --usercontent (for example playground.localhost:8082
and usercontent.localhost:8082: browsers resolve *.localhost to this
machine, and each is a site of its own), /playground.json names the apex,
which has every page and serves the packages, and the shared usercontent
domain whose subdomains run what a project's code does
(packages/runtime/src/lib/site.ts, docs/frames.md), whatever the build
says. The usercontent domain's hosts answer /bridge.html and /sw.js from
build.py's _usercontent/, /bridge.json naming the domain, and nothing
else: the apex's page supplies its frames' files (bridge mode). The apex
sends its packages (/npm/, /boot/) with CORS, which the frames' workers
read directly; its pages are framed only by its own origin
(frame-ancestors; storage.html also by the apex from a former project
origin, p-ID.DOMAIN, whose visitors go to the apex). No other host has
the bootstrap (a package's root/bridge.html answers 404 there too).

With --embedder-host (embedder.localhost:8081, say) that host is a test
embedder of its own site, serving --embedder-root's files cross-origin
isolated, as an embedder serves its page, and the site's packages at
/node_modules/@elixir-playground/NAME/ (PGlite's at
/node_modules/@electric-sql/pglite/), as an embedder's install would have
them, and at their published paths, /npm/@elixir-playground/NAME@VERSION/
(the directory build.py laid each out in, NAME@VERSION+ID), with CORS.
With --bridge DOMAIN (bridge.localhost:8081, say) that domain is a second
shared usercontent domain, as --usercontent's.

The backend's services (the NIF builds, the git proxy, the TCP relay) are
the apex's (docs/frames.md): the apex's worker asks for them, so they
answer only on the apex's host and the embedder's, never on a usercontent
domain's, and only for the origins the backend's allowlist would take,
which here are the apex and --embedders (docs/backend.md): with CORS, and
a WebSocket's Origin checked.
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
        """A browser's request the services do not answer, as the backend
        decides (PlaygroundWeb.ServiceOrigins.request_allowed?): on the
        usercontent domain (the apex's worker asks for them, docs/frames.md);
        with an Origin the site does not let run projects (the apex, this
        host's own, and the embedders are let, with CORS); or without one,
        marked cross-site (another site's <img>). Not a boundary for other
        clients, which send what they like."""
        if self.usercontent() or self.bridge():
            return True
        origin = self.headers.get("Origin")
        if origin:
            return origin not in allowed_origins() and origin != self.own_origin()
        return self.headers.get("Sec-Fetch-Site") == "cross-site"

    def own_origin(self):
        return "http://" + (self.headers.get("Host") or "")

    def foreign(self):
        """Not the apex's own page's request: /hex/ answers only those
        (Caddy: any cross-site request is refused)."""
        origin = self.headers.get("Origin")
        return self.usercontent() or self.bridge() or (origin is not None and origin != self.own_origin()) \
            or self.headers.get("Sec-Fetch-Site") == "cross-site"

    def cors(self):
        """CORS for an allowed origin's request (the apex's worker on another
        site: an embedder's)."""
        origin = self.headers.get("Origin")
        if origin and origin in allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        """A preflight for git's POST (its Content-Type, Git-Protocol), from
        an allowed origin."""
        path = self.path.split("?")[0]
        service = self.GIT.match(path) or self.API.match(path)
        if not service or self.cross_site() or not self.headers.get("Origin"):
            self.send_error(403)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Git-Protocol")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def proxy_hex(self, head):
        path = self.HEX.match(self.path.split("?")[0])
        if not path:
            return False
        if self.foreign():
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
        self.cors()
        self.end_headers()
        self.wfile.write(data)
        return True

    # The backend's NIF builds (docs/backend.md): its answers as they are.
    API = re.compile(r"^/api/v1/nif/[A-Za-z0-9_]+/[A-Za-z0-9_.+-]+(/library\.tar)?$")

    def proxy_api(self):
        if not self.API.match(self.path.split("?")[0]):
            return False
        if self.cross_site():
            self.send_error(403)
            return True
        if NIF is not None:
            return self.nif_fixture()
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
        self.cors()
        self.end_headers()
        self.wfile.write(data)
        return True

    def nif_fixture(self):
        """What the backend answers (PlaygroundWeb.NifController), for the
        builds in --nif's directory."""
        path, _, query = self.path.partition("?")
        package, version, *library = path[len("/api/v1/nif/"):].split("/")
        if not os.path.isdir(os.path.join(NIF, "libraries")):
            return self.json(404, {"error": "no NIF fixtures (python3 -I tests/nif/build.py)"})
        tar = os.path.join(NIF, "libraries", "{abi}", f"{package}-{version}.tar")
        if library:
            # The page asks without ?abi=, as the backend's url has none.
            found = [abi for abi in sorted(os.listdir(os.path.join(NIF, "libraries")))
                     if os.path.isfile(tar.format(abi=abi))]
            if not found:
                return self.json(404, {"error": "not built"})
            with open(tar.format(abi=found[-1]), "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-tar")
            self.send_header("Content-Length", str(len(data)))
            self.cors()
            self.end_headers()
            self.wfile.write(data)
            return True
        abi = urllib.parse.parse_qs(query).get("abi", [None])[0]
        built = sorted(os.listdir(os.path.join(NIF, "libraries")))
        if abi is None:
            return self.json(400, {"error": "name the NIF ABI the page loads (?abi=)"})
        if abi not in built:
            return self.json(409, {"error": f"this backend builds NIF libraries for NIF ABI "
                                            f"{', '.join(built)}, not the page's {abi}"})
        if not os.path.isfile(tar.format(abi=abi)):
            return self.json(422, {"package": package, "version": version, "status": "failed",
                                   "error": f"the tests' fixtures have no build of {package} {version} "
                                            "(tests/nif/build.py)"})
        return self.json(200, {"package": package, "version": version, "status": "succeeded",
                               "url": f"/api/v1/nif/{package}/{version}/library.tar"})

    def json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.cors()
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
        # The TCP relay is the apex's worker's (docs/relay.md): from the
        # apex or an embedder, never the usercontent domain.
        if path == "/relay" and (self.cross_site() or not self.headers.get("Origin")):
            self.send_error(403)
            return True
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

    # Bridge mode's bootstrap, as a package has it: only the shared
    # domain's hosts serve one (docs/frames.md, "Who may bridge").
    BOOTSTRAP = re.compile(r"^(/bridge\.(html|json)|/npm/@elixir-playground/runtime@[^/]+/root/bridge\.html)$")

    def do_GET(self):
        path = self.path.split("?")[0]
        if self.bridge():
            if path == "/bridge.json":
                data = json.dumps({"bridge": self.bridge()}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif path in ("/bridge.html", "/sw.js"):
                super().do_GET()
            else:
                self.send_error(404)
        elif not self.embedder() and (self.BOOTSTRAP.match(path) or path.startswith("/_usercontent/")):
            self.send_error(404)
        elif self.embedder():
            if not self.proxy_hex(False):
                super().do_GET()
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
        path = self.path.split("?")[0]
        if self.bridge() and path not in ("/bridge.html", "/sw.js"):
            self.send_error(404)
        elif not self.bridge() and not self.embedder() and (self.BOOTSTRAP.match(path)
                                                            or path.startswith("/_usercontent/")):
            self.send_error(404)
        elif not self.proxy_hex(True):
            super().do_HEAD()

    def translate_path(self, path):
        relative = os.path.normpath("/" + urllib.parse.unquote(path.split("?")[0])).lstrip("/")
        # The shared domain's files (build.py's _usercontent/).
        if self.bridge():
            return os.path.join(BRIDGE_DIRECTORY, relative)
        # The test embedder's page and scripts, from their own directory, and
        # its install: the site's packages (a package's own path, its
        # index.js), and PGlite.
        if self.embedder():
            module = re.match(r"^node_modules/@elixir-playground/([^/@]+)(/.*)?$", relative)
            if module:
                found = laid(module.group(1))
                rest = (module.group(2) or "").lstrip("/") or "index.js"
                return os.path.join(found, rest) if found else os.path.join(EMBEDDER_ROOT, relative)
            if relative.startswith("node_modules/@electric-sql/pglite/"):
                return os.path.join(ROOT, relative)
            # Its packages at their published paths, which their
            # descriptors' bases name: what bridge mode fetches (docs/frames.md).
            published = re.match(r"^npm/@elixir-playground/([^/@]+)@([0-9.]+)(/.*)?$", relative)
            if published:
                found = laid(published.group(1), published.group(2))
                if found:
                    return os.path.join(found, (published.group(3) or "/").lstrip("/"))
            return os.path.join(EMBEDDER_ROOT, relative or "index.html")
        # A package's published path: the directory build.py laid it out in.
        published = re.match(r"^npm/@elixir-playground/([^/@]+)@([0-9.]+)(/.*)?$", relative)
        if published:
            found = laid(published.group(1), published.group(2))
            if found:
                return os.path.join(found, (published.group(3) or "/").lstrip("/"))
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
        return self.bridge() is not None

    def bridge(self):
        """The shared usercontent domain this host is below (--usercontent,
        or --bridge for a second one), or None."""
        host = (self.headers.get("Host") or "").lower()
        for domain in (USERCONTENT, BRIDGE):
            if domain is not None and host.endswith("." + domain.lower()):
                return domain
        return None

    def end_headers(self):
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        path = self.path.split("?")[0]
        if self.embedder():
            # An embedder's own page, cross-origin isolated as it must be;
            # its files (an app's archive) fetched by the project's frame,
            # another site: with CORS.
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            # Its packages' files, which bridge mode's frames read
            # themselves with data: 'direct' (another site): CORS and CORP,
            # as a CDN would send them.
            public = path.startswith(("/npm/", "/boot/"))
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin" if public else "same-origin")
            self.send_header("Access-Control-Allow-Origin", "*")
        elif self.usercontent() or self.bridge():
            # The apex's pages frame these from another site.
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        else:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            # The packages' files and the recordings: the frames' workers on
            # the usercontent domain read them (docs/frames.md, "The data
            # path"), from origins no single name covers. The rest: a
            # former project origin and the apex frame each other (the same
            # site).
            public = path.startswith(("/npm/", "/boot/"))
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin" if public else "same-site")
            if public:
                self.send_header("Access-Control-Allow-Origin", "*")
            # No other site frames the apex's pages (its origin would run a
            # stranger's frames' code, docs/frames.md). A former project
            # origin's storage.html is framed by the apex itself.
            ancestors = "'self'"
            domain = site_config().get("domain")
            host = (self.headers.get("Host") or "").lower()
            if path == "/storage.html" and domain and host != domain.lower():
                ancestors += f" http://{domain} https://{domain}"
            self.send_header("Content-Security-Policy", f"frame-ancestors {ancestors}")
        # --immutable: a package's files as production sends them (their
        # paths are immutable), for measuring with a warm HTTP cache.
        if IMMUTABLE and path.startswith(("/npm/", "/boot/")):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def laid(name, version=None):
    """Where build.py laid out package `name` (of `version`): its
    NAME@VERSION+ID directory, the newest; None without one."""
    top = os.path.join(directory, "npm", "@elixir-playground")
    prefix = f"{name}@{version}+" if version else f"{name}@"
    found = sorted((entry for entry in os.listdir(top) if entry.startswith(prefix)),
                   key=lambda entry: os.path.getmtime(os.path.join(top, entry))) if os.path.isdir(top) else []
    return os.path.join(top, found[-1]) if found else None


def allowed_origins():
    """The origins the services answer, as the backend's allowlist would
    (PLAYGROUND_SERVICE_ORIGINS, docs/backend.md): the apex (--domain, or
    playground.json's) and --embedders."""
    config = site_config()
    domain = config.get("domain")
    return set(EMBEDDERS.split() if EMBEDDERS else []) | ({f"http://{domain}", f"https://{domain}"} if domain else set())


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
BRIDGE_DIRECTORY = os.path.join(directory, "_usercontent")
args = sys.argv[1:]
OPTIONS = ("--domain", "--usercontent", "--api", "--nif", "--embedders", "--embedder-host", "--embedder-root",
           "--bridge")
option = lambda name: args[args.index(name) + 1] if name in args else None
DOMAIN = option("--domain")
USERCONTENT = option("--usercontent")
EMBEDDERS = option("--embedders")
EMBEDDER_HOST = option("--embedder-host")
BRIDGE = option("--bridge")
IMMUTABLE = "--immutable" in args
EMBEDDER_ROOT = os.path.abspath(option("--embedder-root") or ".")
NIF = option("--nif") and os.path.abspath(option("--nif"))
OVERRIDES = {key: value for key, value in (("domain", DOMAIN), ("usercontent", USERCONTENT))
             if value is not None}
API = (args[args.index("--api") + 1] if "--api" in args else "https://run-elixir.dev").rstrip("/")
args = [arg for i, arg in enumerate(args)
        if arg not in OPTIONS and arg != "--immutable" and (i == 0 or args[i - 1] not in OPTIONS)]
port = int(args[0]) if args else 8080
print(f"http://localhost:{port}/ serving {directory}, NIF builds from {NIF or API}, "
      f"live sessions from {API}")
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=directory)).serve_forever()
