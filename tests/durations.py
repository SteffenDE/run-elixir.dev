"""Each test's duration in the last run, slowest first, against its timeout.

    python3 -I tests/durations.py [results.json]

Reads Playwright's JSON report (target/tests/results.json, which
playwright.config.ts writes every run): per test and browser, its status,
how long it took and the timeout it ran under, so a timeout can be set to
a few times the slowest normal run (docs/testing.md).
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def specs(suite, path=()):
    for spec in suite.get("specs", []):
        yield path + (spec["title"],), spec
    for child in suite.get("suites", []):
        yield from specs(child, path + ((child.get("title") or ""),) if child.get("file") is None else path)


def main():
    report = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "target", "tests", "results.json")
    with open(report) as f:
        data = json.load(f)
    rows = []
    for top in data["suites"]:
        for _, spec in specs(top):
            for test in spec["tests"]:
                for result in test["results"][-1:]:
                    rows.append((result["duration"] / 1000, test["projectName"], spec["file"],
                                 spec["title"], result["status"], test.get("timeout", 0) / 1000))
    for seconds, project, file, title, status, timeout in sorted(rows, reverse=True):
        print(f"{seconds:7.1f}s  {timeout:6.0f}s  {project:8} {status:8} {file}: {title[:70]}")


if __name__ == "__main__":
    main()
