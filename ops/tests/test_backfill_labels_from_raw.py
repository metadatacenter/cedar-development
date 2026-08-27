"""backfill-labels-from-raw.sh, run against a sandbox instead of the stack.

The script is copied into a temporary directory beside a fake cedar-services.sh, and a fake
java records its arguments and exits with a chosen code, so the tests exercise the real shell
under /bin/bash (macOS 3.2) without stopping the shared terminology server or launching an
ingest. What they pin: the all-ontologies mode survives the empty acronym array under
``set -u`` (bash 3.2 calls an unguarded empty array unbound), the ingest's exit status becomes
the script's, and the restart runs from a trap so terminology comes back even when the ingest
fails.
"""

import os
import shutil
import stat
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

OPS_DIR = Path(__file__).resolve().parent.parent
SCRIPT = OPS_DIR / "backfill-labels-from-raw.sh"


class BackfillLabelsFromRawTest(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        # The script resolves cedar-services.sh beside itself, so copying it here makes the
        # sandbox's fake the one it stops and starts.
        self.script = self.tmp / "backfill-labels-from-raw.sh"
        shutil.copy(SCRIPT, self.script)
        self.svc_log = self.tmp / "svc.log"
        self._write_executable(self.tmp / "cedar-services.sh",
                               "#!/bin/bash\n"
                               f"echo \"svc:$*\" >> '{self.svc_log}'\n")

        # A prepared ingest module and classpath file, so the Maven branch is skipped.
        ts_dir = self.tmp / "cedar-terminology-server"
        (ts_dir / "cedar-terminology-server-ingest" / "target" / "classes").mkdir(parents=True)
        work = self.tmp / "work" / "label-raw-backfill"
        work.mkdir(parents=True)
        (work / "deps.txt").write_text("dep.jar\n")
        self.ts_dir = ts_dir

        # The fake JVM records its argument vector, one argument per line.
        self.java_log = self.tmp / "java-args.log"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.catalog = self.tmp / "catalog.sqlite"
        self.catalog.write_text("")
        self.snapshots = self.tmp / "snapshots"
        self.snapshots.mkdir()

    def _write_executable(self, path, content):
        path.write_text(content)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _fake_java(self, exit_code):
        self._write_executable(self.bin / "java",
                               "#!/bin/bash\n"
                               f"printf '%s\\n' \"$@\" >> '{self.java_log}'\n"
                               f"exit {exit_code}\n")

    def _run(self, *args):
        env = dict(os.environ,
                   PATH=f"{self.bin}:{os.environ['PATH']}",
                   TS_DIR=str(self.ts_dir),
                   TMPDIR=str(self.tmp / "work"))
        return subprocess.run(
            ["/bin/bash", str(self.script), str(self.catalog), str(self.snapshots), *args],
            capture_output=True, text=True, env=env, timeout=120)

    def test_all_ontologies_mode_survives_the_empty_acronym_array_and_restarts(self):
        self._fake_java(0)
        result = self._run()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("unbound variable", result.stderr)
        self.assertIn("DONE", result.stdout)
        self.assertEqual(["svc:stop terminology", "svc:start terminology"],
                         self.svc_log.read_text().splitlines())
        java_args = self.java_log.read_text().splitlines()
        self.assertEqual("--backfill-labels-from-raw", java_args[-1],
                         "no acronyms means no trailing arguments, not an empty one")

    def test_a_failed_ingest_still_restarts_terminology_and_reports_its_exit_status(self):
        self._fake_java(3)
        result = self._run()
        self.assertEqual(3, result.returncode)
        self.assertIn("FAILED", result.stderr)
        self.assertNotIn("DONE", result.stdout)
        self.assertEqual(["svc:stop terminology", "svc:start terminology"],
                         self.svc_log.read_text().splitlines(),
                         "the trap restarts terminology on the failure path")

    def test_named_acronyms_reach_the_ingest_and_no_restart_is_honored(self):
        self._fake_java(0)
        result = self._run("MESH", "DOID", "--no-restart")
        self.assertEqual(0, result.returncode, result.stderr)
        java_args = self.java_log.read_text().splitlines()
        self.assertEqual(["MESH", "DOID"], java_args[-2:])
        self.assertEqual(["svc:stop terminology"], self.svc_log.read_text().splitlines(),
                         "--no-restart leaves terminology stopped, as documented")


if __name__ == "__main__":
    unittest.main()
