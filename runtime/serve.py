"""Serve the playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, and index.html
for paths that are no file (a project's /ID/), as Caddy does in
production.

    python3 -I playground/runtime/serve.py [PORT]
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript"}

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
