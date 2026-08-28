import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "cedar_term_gate.sh"


class CedarTermGateTest(unittest.TestCase):

    def test_verify_stops_before_diff_when_instance_never_becomes_healthy(self):
        with tempfile.TemporaryDirectory() as temporary:
            cedar_home = Path(temporary)
            fake_bin = cedar_home / "fake-bin"
            fake_bin.mkdir()
            report_dir = cedar_home / "reports"
            report_dir.mkdir()
            app = cedar_home / "cedar-terminology-server" / "cedar-terminology-server-application"
            (app / "target").mkdir(parents=True)
            (app / "src" / "main" / "resources").mkdir(parents=True)
            (app / "target" / "cedar-terminology-server-application-test.jar").touch()
            (app / "src" / "main" / "resources" / "config.yml").touch()
            python_marker = cedar_home / "python-was-called"

            commands = {
                "curl": "#!/bin/sh\nexit 7\n",
                "sleep": "#!/bin/sh\nexit 0\n",
                "sqlite3": "#!/bin/sh\necho TEST\n",
                "java": "#!/bin/sh\necho fake server failed to start\nexit 1\n",
                "python3": f"#!/bin/sh\ntouch '{python_marker}'\nexit 0\n",
            }
            for name, body in commands.items():
                command = fake_bin / name
                command.write_text(body, encoding="utf-8")
                command.chmod(0o755)

            result = subprocess.run(
                ["bash", str(SCRIPT), "verify"],
                env={
                    **os.environ,
                    "PATH": f"{fake_bin}:{os.environ['PATH']}",
                    "CEDAR_HOME": str(cedar_home),
                    "CEDAR_VERSION": "test",
                    "TERM_REPORT_DIR": str(report_dir),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("did not become healthy on admin port 19104", result.stderr)
            self.assertIn(str(report_dir / "term-gate-instance.log"), result.stderr)
            self.assertNotIn("integrated-search gate", result.stdout)
            self.assertFalse(python_marker.exists())


if __name__ == "__main__":
    unittest.main()
