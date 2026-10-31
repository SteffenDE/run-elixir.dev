"""Development server's cross-origin service preflights.

    python3 -I tests/serve.py
"""
import contextlib
import http.client
import http.server
import io
from pathlib import Path
import runpy
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "http://embedder.test"


class Preflight(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load the script with its server startup disabled, then run its
        # real handler on a free local port. No upstream service is needed.
        with patch("sys.argv", ["serve.py", "0", "--domain", "apex.test",
                                "--embedders", ORIGIN]), \
                patch("http.server.ThreadingHTTPServer"), \
                contextlib.redirect_stdout(io.StringIO()):
            handler = runpy.run_path(str(ROOT / "runtime/serve.py"))["Handler"]
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def preflight(self, origin):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request("OPTIONS", "/git/github.com/test/repo/git-upload-pack", headers={
                "Host": "apex.test",
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,git-protocol",
            })
            response = connection.getresponse()
            response.read()
            return response.status, response.headers
        finally:
            connection.close()

    def test_allowed_embedder_can_send_git_requests(self):
        status, headers = self.preflight(ORIGIN)
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertIn("Origin", headers["Vary"])
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])
        self.assertIn("Git-Protocol", headers["Access-Control-Allow-Headers"])

    def test_other_origins_are_refused(self):
        status, headers = self.preflight("http://other.test")
        self.assertEqual(status, 403)
        self.assertIsNone(headers["Access-Control-Allow-Origin"])


if __name__ == "__main__":
    unittest.main()
