"""Serve the playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, index.html for
paths that are no file (a project's /ID/), and Hex's repository at /hex/
(repo.hex.pm sends no CORS headers; app/src/project/lib/hex.ts), as Caddy
does in production.

    python3 -I playground/runtime/serve.py [PORT]
"""
import functools
import http.server
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

    def do_GET(self):
        if not self.proxy_hex(False):
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
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


directory = os.path.join(ROOT, "target", "playground", "site")
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f"http://localhost:{port}/ serving {directory}")
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=directory)).serve_forever()
