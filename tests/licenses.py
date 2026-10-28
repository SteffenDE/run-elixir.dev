"""tools/licenses.py and runtime/notices.py: SPDX expressions, the checks an
inventory passes before it is written, and a package's notices.

    python3 -I tests/licenses.py
"""

import importlib.util
import os
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    spec = importlib.util.spec_from_file_location(os.path.splitext(os.path.basename(path))[0],
                                                  os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


licenses = load("tools/licenses.py")
notices = load("runtime/notices.py")


class Expressions(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(licenses.parse("MIT"), "MIT")
        self.assertEqual(licenses.parse("MIT OR Apache-2.0 AND Zlib"),
                         ("OR", ["MIT", ("AND", ["Apache-2.0", "Zlib"])]))
        self.assertEqual(licenses.parse("Apache-2.0 WITH LLVM-exception"),
                         ("WITH", "Apache-2.0", "LLVM-exception"))
        with self.assertRaises(ValueError):
            licenses.parse("(MIT")

    def test_normal(self):
        self.assertEqual(licenses.normal("MIT OR Apache-2.0"), "Apache-2.0 OR MIT")
        self.assertEqual(licenses.normal("(MIT OR Apache-2.0) AND Zlib"), "(Apache-2.0 OR MIT) AND Zlib")
        self.assertEqual(licenses.conjunction(["MIT", "Apache-2.0 OR MIT", "MIT"]), "(Apache-2.0 OR MIT) AND MIT")

    def test_needs_source(self):
        self.assertTrue(licenses.needs_source("GPL-2.0-only"))
        self.assertTrue(licenses.needs_source("MIT AND GPL-3.0-or-later"))
        # A permissive choice is no obligation.
        self.assertFalse(licenses.needs_source("Apache-2.0 OR GPL-2.0-only"))
        self.assertFalse(licenses.needs_source("Apache-2.0 WITH LLVM-exception"))

    def test_classify(self):
        self.assertEqual(licenses.classify("Apache License\n==============\nVersion 2.0, January 2004"),
                         "Apache-2.0")
        self.assertEqual(licenses.classify("Permission is hereby granted, free of charge, to any person"), "MIT")
        self.assertIsNone(licenses.classify("All rights reserved."))


class Checks(unittest.TestCase):
    def test_unknown_license(self):
        inventory = licenses.Inventory().add("x", "1", "MIT", "https://x", {"LICENSE": b"text"})
        inventory.components[0]["license"] = "Proprietary"
        with self.assertRaises(SystemExit) as raised:
            inventory.check()
        self.assertIn("Proprietary is not an allowed license", str(raised.exception))

    def test_copyleft_without_source(self):
        inventory = licenses.Inventory().add("x", "1", "GPL-3.0-or-later", "https://x", {"COPYING": b"text"})
        with self.assertRaises(SystemExit) as raised:
            inventory.check()
        self.assertIn("needs its source", str(raised.exception))

    def test_no_text_gets_the_standard_one(self):
        component = licenses.Inventory().add("x", "1", "MIT", "https://x", {}).components[0]
        self.assertEqual(list(component["texts"]), ["MIT.txt"])
        self.assertIn("Ships no license file", component["note"])

    def test_npm_names(self):
        self.assertIn("LicenseRef-Remix-Icon-1.0", licenses.ALLOWED)
        self.assertEqual(notices.NPM_LICENSES["Remix Icon License 1.0"], "LicenseRef-Remix-Icon-1.0")


class Packages(unittest.TestCase):
    def test_write(self):
        inventory = notices.own().add("gpl", "1", "GPL-2.0-only", "https://x", {"COPYING": b"GPL"},
                                      source="source/gpl/")
        with tempfile.TemporaryDirectory() as scratch, tempfile.TemporaryDirectory() as source:
            with open(os.path.join(source, "README.md"), "w") as f:
                f.write("source")
            added, expression = notices.write(scratch, "@elixir-playground/x", inventory, {"gpl": source})
            self.assertEqual(sorted(added), ["LICENSE", "NOTICE.md", "licenses", "source"])
            self.assertEqual(expression, "Apache-2.0 AND GPL-2.0-only")
            self.assertTrue(os.path.exists(os.path.join(scratch, "source", "gpl", "README.md")))
            self.assertTrue(os.path.exists(os.path.join(scratch, "licenses", "index.json")))
            with open(os.path.join(scratch, "NOTICE.md")) as f:
                self.assertIn("[source](source/gpl/)", f.read())

    def test_write_without_its_source(self):
        inventory = licenses.Inventory().add("gpl", "1", "GPL-2.0-only", "https://x", {"COPYING": b"GPL"},
                                             source="source/gpl/")
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(SystemExit):
                notices.write(scratch, "@elixir-playground/x", inventory, {})


if __name__ == "__main__":
    unittest.main()
