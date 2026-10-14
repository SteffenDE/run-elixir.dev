"""Serve the playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, index.html for
paths that are no file (a project's /ID/), Hex's repository at /hex/
(repo.hex.pm sends no CORS headers; app/src/project/lib/hex.ts) and git
clones at /git/HOST/ (app/src/project/lib/programs/git.ts), as Caddy
does in production.

    python3 -I playground/runtime/serve.py [PORT] [--domain DOMAIN]

With --domain (for example playground.localhost:8082: browsers resolve
*.localhost to this machine, and with two labels the apex and its
projects are one site), /playground.json names it the project domain:
projects run at ID.DOMAIN (app/src/shared/lib/site.ts), whatever the
build says.
"""
import functools
import http.server
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript"}

    # What Hex fetches from its repository, and nothing else.
    HEX = re.compile(r"^/hex/(names|versions|public_key|(packages|tarballs)/[A-Za-z0-9_.+-]+)$")

    def proxy_hex(self, head):
        path = self.HEX.match(self.path.split("?")[0])
        if not path:
            return False
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
        if (method, endpoint, query) not in (("GET", "info/refs", "service=git-upload-pack"),
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

    def do_POST(self):
        if not self.proxy_git("POST"):
            self.send_error(405)

    def do_GET(self):
        if DOMAIN is not None and self.path.split("?")[0] == "/playground.json":
            data = json.dumps({"domain": DOMAIN}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif not self.proxy_hex(False) and not self.proxy_git("GET"):
            super().do_GET()

    def do_HEAD(self):
        if not self.proxy_hex(True):
            super().do_HEAD()

    def send_head(self):
        # The app's routes (/ID/, /phoenix, ...) are the page.
        if not os.path.exists(self.translate_path(self.path)):
            self.path = "/index.html"
        return super().send_head()

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # A project's origin and the apex frame each other (the same site).
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


directory = os.path.join(ROOT, "target", "playground", "site")
args = sys.argv[1:]
DOMAIN = args[args.index("--domain") + 1] if "--domain" in args else None
args = [arg for i, arg in enumerate(args) if arg != "--domain" and (i == 0 or args[i - 1] != "--domain")]
port = int(args[0]) if args else 8080
print(f"http://localhost:{port}/ serving {directory}")
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=directory)).serve_forever()
