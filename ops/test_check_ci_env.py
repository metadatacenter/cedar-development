"""Which workflows check_ci_env.py treats as copies of the CI environment block, and what --apply rewrites.

The npm frontends set CEDAR_ variables of their own in a job-level env: at the indentation a copy
of the block uses. A check that took any such entry for a copy reported three frontends as drifted,
and its --apply replaced their browser jobs' settings with the Java repositories' block.
"""
import tempfile
import unittest
from pathlib import Path

import check_ci_env

CANONICAL = check_ci_env.CANONICAL.read_text(encoding="utf-8").rstrip("\n")

JAVA = """name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      BMIR_NEXUS_USERNAME: ${{ secrets.BMIR_NEXUS_USERNAME }}
{block}
    steps:
      - uses: actions/checkout@v7
"""

FRONTEND = """name: CI
on: [push]
jobs:
  browser:
    runs-on: ubuntu-latest
    env:
      # Local CI must not run this suite with the machine's default worker count.
      CEDAR_TEST_WORKERS: '2'
      CEDAR_REQUIRE_SHARED_EDITORS: '1'
    steps:
      - uses: actions/checkout@v7
      - run: npm run test:browser
        env:
          CEDAR_HOST: metadatacenter.orgx
"""


class WorkflowSelectionTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = Path(folder.name)

    def workflow(self, repository, text):
        path = self.home / repository / ".github" / "workflows" / "ci.yml"
        path.parent.mkdir(parents=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_only_a_copy_of_the_block_is_selected(self):
        java = self.workflow("cedar-example-server", JAVA.format(block=CANONICAL))
        self.workflow("cedar-example-frontend", FRONTEND)
        self.assertEqual([("cedar-example-server", java)], list(check_ci_env.workflows(self.home)))

    def test_the_region_is_the_block_and_nothing_after_it(self):
        text = JAVA.format(block=CANONICAL)
        first, last = check_ci_env.block_region(text)
        self.assertEqual(CANONICAL, "\n".join(text.splitlines()[first:last + 1]))
        self.assertIsNone(check_ci_env.block_region(FRONTEND))

    def test_apply_rewrites_a_drifted_copy_and_nothing_else(self):
        drifted = CANONICAL.replace("      CEDAR_HOST: metadatacenter.orgx\n", "")
        self.assertNotEqual(drifted, CANONICAL)
        java = self.workflow("cedar-example-server", JAVA.format(block=drifted))
        frontend = self.workflow("cedar-example-frontend", FRONTEND)
        for name, path in check_ci_env.workflows(self.home):
            first, last = check_ci_env.block_region(path.read_text(encoding="utf-8"))
            check_ci_env.rewrite(path, first, last, CANONICAL)
        self.assertEqual(JAVA.format(block=CANONICAL), java.read_text(encoding="utf-8"))
        self.assertEqual(FRONTEND, frontend.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
