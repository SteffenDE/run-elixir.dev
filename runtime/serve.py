"""Serve a playground site (build.py's output) on http://localhost:8080
with the cross-origin isolation SharedArrayBuffer needs, as Caddy does in
production.

    python3 -I playground/runtime/serve.py [SITE] [PORT]
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


directory = os.path.join(ROOT, "target", "playground", sys.argv[1] if len(sys.argv) > 1 else "elixir")
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
print(f"http://localhost:{port}/ serving {directory}")
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=directory)).serve_forever()
