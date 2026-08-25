import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "cedar-services.sh"
DEVELOPMENT = Path(__file__).resolve().parents[2]


class NativeProcessSafetyTest(unittest.TestCase):

    def run_library(self, body):
        with tempfile.TemporaryDirectory() as temporary:
            cedar_home = Path(temporary)
            (cedar_home / "cedar-profile-native-develop.sh").write_text(
                "export CEDAR_VERSION=2.9.3-SNAPSHOT\n"
                f"export CEDAR_DEVELOP_HOME={DEVELOPMENT}\n",
                encoding="utf-8",
            )
            environment = {
                **os.environ,
                "CEDAR_HOME": str(cedar_home),
                "CEDAR_SERVICES_LIBRARY_ONLY": "true",
            }
            return subprocess.run(
                ["bash", "-c", 'source "$1"; eval "$2"', "test", str(SCRIPT), body],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_docker_port_proxy_is_not_a_native_microservice(self):
        result = self.run_library(
            'process_command() { echo "/Applications/Docker.app/Contents/MacOS/com.docker.backend"; }; '
            'process_cwd() { echo "/"; }; '
            'is_service_process group 4242'
        )

        self.assertNotEqual(0, result.returncode)

    def test_an_older_native_jar_is_still_recognized_for_safe_shutdown(self):
        result = self.run_library(
            'process_command() { echo "java -jar '
            '$CEDAR_HOME/cedar-group-server/cedar-group-server-application/target/'
            'cedar-group-server-application-2.9.2.jar server config.yml"; }; '
            'is_service_process group 4242'
        )

        self.assertEqual(0, result.returncode, result.stderr)

    def test_stop_refuses_an_unknown_port_owner_without_signalling_it(self):
        result = self.run_library(
            'port_owner() { echo 4242; }; '
            'process_command() { echo "/Applications/Docker.app/Contents/MacOS/com.docker.backend"; }; '
            'process_cwd() { echo "/"; }; '
            'remove_launchd_job() { :; }; '
            'kill() { [ "$1" = "-0" ] && return 0; echo SIGNALLED; return 0; }; '
            'stop_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("REFUSED TO STOP", result.stderr)
        self.assertNotIn("SIGNALLED", result.stdout + result.stderr)

    def test_missing_jar_makes_native_start_fail(self):
        result = self.run_library(
            'port_open() { return 1; }; start_one artifact'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("JAR MISSING", result.stdout)

    def test_missing_main_frontend_source_makes_native_start_fail(self):
        result = self.run_library(
            'port_open() { return 1; }; start_one frontend'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("SRC MISSING", result.stdout)

    def test_missing_microservice_config_makes_native_start_fail(self):
        result = self.run_library(
            'base="$CEDAR_HOME/cedar-group-server/cedar-group-server-application"; '
            'mkdir -p "$base/target"; '
            'touch "$base/target/cedar-group-server-application-$CEDAR_VERSION.jar"; '
            'port_open() { return 1; }; start_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("CONFIG MISSING", result.stdout)

    def test_related_stop_scripts_scope_the_process_they_signal(self):
        keycloak = (DEVELOPMENT / "bin/util/services-generic/killkeycloak.sh").read_text()
        opensearch = (DEVELOPMENT / "bin/util/services-osx/stopopensearch.sh").read_text()
        aliases = (DEVELOPMENT / "bin/util/set-infra-aliases-osx.sh").read_text()
        start_infra = (DEVELOPMENT / "bin/util/services-generic/startinfra.sh").read_text()
        stop_infra = (DEVELOPMENT / "bin/util/services-generic/stopinfra.sh").read_text()

        self.assertIn('case "$command"', keycloak)
        self.assertIn('$CEDAR_KEYCLOAK_HOME', keycloak)
        self.assertIn('case "${OS_COMMAND}"', opensearch)
        self.assertIn('"${OS_PREFIX}"', opensearch)
        self.assertNotIn("pgrep gulp", aliases)
        self.assertIn("cedar-services.sh stop frontend", aliases)
        self.assertIn("startmongo || CEDAR_INFRA_FAILED=1", start_infra)
        self.assertIn("stopmongo || CEDAR_INFRA_FAILED=1", stop_infra)

    def test_running_inventory_ignores_foreign_port_owners(self):
        result = self.run_library(
            'port_owner() { echo 4242; }; '
            'process_command() { echo "/Applications/Docker.app/Contents/MacOS/com.docker.backend"; }; '
            'process_cwd() { echo "/"; }; '
            'running group'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
