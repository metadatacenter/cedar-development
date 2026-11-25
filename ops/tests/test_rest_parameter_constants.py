#!/usr/bin/env python3
"""Static guard against JAX-RS parameter names written as string literals.

A query, path or form parameter name is part of the REST contract. Each one is a constant in
cedar-model-library's CedarQueryParameters or cedar-server-globals-library's CedarPathParameters,
so a server and the clients that share those classes cannot spell the same parameter two ways.
"""

import re
import tempfile
import unittest
from collections import Counter
from pathlib import Path


CEDAR_HOME = Path(__file__).resolve().parents[3]
BACKEND_REPOSITORIES = sorted(CEDAR_HOME.glob("cedar-*-server")) + [
    CEDAR_HOME / "cedar-microservice-libraries"
]

# The value may follow `value =`, the annotation may break across lines, and its name may be
# fully qualified.
LITERAL_PARAMETER = re.compile(
    r'@(?:(?:jakarta|javax)\.ws\.rs\.)?(?P<kind>QueryParam|PathParam|FormParam)'
    r'\(\s*(?:value\s*=\s*)?"(?P<name>[^"]*)"\s*\)'
)


def _line_number(text, offset):
    return text.count("\n", 0, offset) + 1


def literal_parameters(text):
    """Each JAX-RS parameter annotation in a Java source whose value is a string literal."""
    return [(_line_number(text, match.start()), f'@{match.group("kind")}("{match.group("name")}")')
            for match in LITERAL_PARAMETER.finditer(text)]


def main_sources(repository):
    """The main Java sources of one backend repository, across all of its modules."""
    return sorted(path for path in repository.glob("**/src/main/java/**/*.java")
                  if "target" not in path.relative_to(repository).parts)


class RestParameterConstantsTest(unittest.TestCase):

    def test_parameter_names_are_shared_constants(self):
        present = [repository for repository in BACKEND_REPOSITORIES if repository.is_dir()]
        if not present:
            # A checkout of cedar-development alone has no backend repository beside it. Passing
            # there would report a scan that never happened.
            self.skipTest(f"no backend repository beside cedar-development under {CEDAR_HOME}")
        violations = []
        per_repository = Counter()
        for repository in present:
            for path in main_sources(repository):
                for line, annotation in literal_parameters(path.read_text(encoding="utf-8")):
                    violations.append(f"{path.relative_to(CEDAR_HOME)}:{line}: {annotation}")
                    per_repository[repository.name] += 1

        summary = ", ".join(f"{name} {count}" for name, count in sorted(per_repository.items()))
        self.assertEqual(
            [],
            violations,
            "Name every JAX-RS parameter by a constant from CedarQueryParameters or "
            f"CedarPathParameters, adding one if none exists ({summary}):\n" + "\n".join(violations),
        )

    def test_the_guard_finds_literals_and_admits_constants(self):
        java = """public Response find(
    @PathParam("id") String id,
    @QueryParam(QP_LIMIT) Optional<Integer> limit,
    @QueryParam(value = "offset") Optional<Integer> offset,
    @FormParam(
        "state") String state,
    @PathParam(PP_ID) String other,
    @jakarta.ws.rs.QueryParam("uri") String uri) {
"""
        self.assertEqual(
            [(2, '@PathParam("id")'), (4, '@QueryParam("offset")'), (5, '@FormParam("state")'),
             (8, '@QueryParam("uri")')],
            literal_parameters(java),
        )

    def test_only_main_java_sources_are_scanned(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = Path(folder) / "cedar-example-server"
            main = repository / "cedar-example-server-application/src/main/java/Example.java"
            test = repository / "cedar-example-server-application/src/test/java/ExampleTest.java"
            built = repository / "cedar-example-server-application/target/src/main/java/Built.java"
            for path in (main, test, built):
                path.parent.mkdir(parents=True)
                path.write_text("class Example {}\n")
            self.assertEqual([main], main_sources(repository))


if __name__ == "__main__":
    unittest.main()
