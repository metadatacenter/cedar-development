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
            # The controller takes the environment its caller already loaded, which is how
            # cedarcli invokes it, so the test supplies one rather than a profile to source.
            environment = {
                **os.environ,
                "CEDAR_HOME": str(cedar_home),
                "CEDAR_DEVELOP_HOME": str(DEVELOPMENT),
                "CEDAR_PROFILE": "develop",
                "CEDAR_VERSION": "2.9.3-SNAPSHOT",
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
            'remove_launchd_job() { return 1; }; '
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
            'port_open() { return 1; }; start_one ui-main'
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

    def test_start_refuses_a_stale_service_on_an_auxiliary_port(self):
        result = self.run_library(
            'port_open() { [ "$1" = 9209 ]; }; auxiliary_ports() { echo 9209; }; '
            'port_owner() { echo 4242; }; is_service_process() { return 0; }; '
            'start_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("stale CEDAR pid 4242 owns auxiliary port 9209", result.stderr)

    def test_macos_start_submits_a_non_restarting_launchd_job(self):
        result = self.run_library(
            'base="$CEDAR_HOME/cedar-group-server/cedar-group-server-application"; '
            'mkdir -p "$base/target" "$base/src/main/resources"; '
            'touch "$base/target/cedar-group-server-application-$CEDAR_VERSION.jar"; '
            'touch "$base/src/main/resources/config.yml"; '
            'port_open() { return 1; }; uname() { echo Darwin; }; '
            'remove_launchd_job() { return 1; }; launchd_job_pid() { echo 4242; }; '
            'launchctl() { printf "%s\\n" "$*"; }; '
            'start_one group'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("submit -l org.metadatacenter.cedar.native.group", result.stdout)
        self.assertIn("-- /bin/bash -c", result.stdout)
        self.assertIn('exec "$3" run-one "$4"', result.stdout)
        self.assertIn(f"develop {SCRIPT} group", result.stdout)
        self.assertIn("started group (pid 4242)", result.stdout)

    def test_macos_start_refuses_a_job_launchd_would_start_without_a_profile(self):
        """launchd hands a submitted job its own environment, so an unnamed profile is fatal."""
        result = self.run_library(
            'unset CEDAR_PROFILE; '
            'base="$CEDAR_HOME/cedar-group-server/cedar-group-server-application"; '
            'mkdir -p "$base/target" "$base/src/main/resources"; '
            'touch "$base/target/cedar-group-server-application-$CEDAR_VERSION.jar"; '
            'touch "$base/src/main/resources/config.yml"; '
            'port_open() { return 1; }; uname() { echo Darwin; }; '
            'remove_launchd_job() { return 1; }; launchd_job_pid() { echo 4242; }; '
            'launchctl() { printf "%s\\n" "$*"; }; '
            'start_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("CEDAR_PROFILE is not set", result.stderr)
        self.assertNotIn("submit -l", result.stdout)

    def test_stop_removes_a_launchd_job_and_its_pidfile(self):
        result = self.run_library(
            'echo 4242 > "$(pidfile group)"; '
            'remove_launchd_job() { return 0; }; port_open() { return 1; }; '
            'stop_one group; [ ! -e "$(pidfile group)" ]'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("stopped group (pid 4242)", result.stdout)

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
        self.assertIn("cedar-services.sh stop ui-main", aliases)
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

    def test_health_checks_only_the_named_services(self):
        result = self.run_library(
            'names() { printf "%s\\n" "$@"; }; '
            'health_of() { [ "$1" = terminology ] && echo healthy || echo down; }; '
            'health terminology'
        )

        self.assertEqual(0, result.returncode, result.stderr)

    def test_health_fails_when_a_selected_service_is_unhealthy(self):
        result = self.run_library(
            'names() { printf "%s\\n" "$@"; }; '
            'health_of() { echo down; }; '
            'health terminology'
        )

        self.assertNotEqual(0, result.returncode)

    def test_status_defers_docker_owned_services_to_docker_status(self):
        result = self.run_library(
            'names() { printf "group\\nartifact\\n"; }; '
            'service_port_owner() { return 1; }; '
            'port_owner() { [ "$1" = 9009 ] && echo 4242; }; '
            'port_open() { [ "$1" = 9009 ]; }; '
            'process_command() { echo "/Applications/Docker.app/Contents/MacOS/com.docker.backend"; }; '
            'docker_service_running() { [ "$1" = artifact ]; }; '
            'binary_of() { echo -; }; '
            'logfile() { echo "$CEDAR_HOME/missing.log"; }; '
            'health_of() { echo SHOULD_NOT_BE_USED; }; '
            'status'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertRegex(result.stdout, r"group\s+docker\s+up\s+docker")
        self.assertRegex(result.stdout, r"artifact\s+docker\s+internal\s+docker")
        self.assertIn("run cedarcli docker status for container health", result.stdout)
        self.assertNotIn("native healthy:", result.stdout)
        self.assertNotIn("!4242", result.stdout)
        self.assertNotIn("SHOULD_NOT_BE_USED", result.stdout)
        self.assertNotIn("ERROR:", result.stdout)

    def test_status_keeps_a_real_foreign_listener_as_an_error(self):
        result = self.run_library(
            'names() { echo group; }; '
            'service_port_owner() { return 1; }; '
            'port_owner() { echo 4242; }; '
            'port_open() { return 0; }; '
            'process_command() { echo "python unrelated.py"; }; '
            'docker_service_running() { return 1; }; '
            'binary_of() { echo -; }; '
            'logfile() { echo "$CEDAR_HOME/missing.log"; }; '
            'health_of() { echo starting; }; '
            'status'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertRegex(result.stdout, r"group\s+!4242\s+up\s+starting")
        self.assertIn("ERROR: 1 service port(s) marked !pid", result.stdout)
        self.assertNotIn("cedarcli docker status", result.stdout)

    def test_machine_status_contains_the_fields_needed_by_cedarcli(self):
        result = self.run_library(
            'names() { echo group; }; '
            'pidfile() { echo /does/not/exist; }; '
            'app_port() { echo 9009; }; '
            'service_port_owner() { echo 4242; }; '
            'port_open() { return 0; }; '
            'health_of() { echo healthy; }; '
            'binary_of() { echo current; }; '
            'logfile() { echo "$CEDAR_HOME/missing.log"; }; '
            'status_tsv'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(
            "service\tpid\tport\tlistener\thealth\tbinary\tlog_errors\n"
            "group\t~4242\t9009\tup\thealthy\tcurrent\t0\n",
            result.stdout,
        )

    def test_log_error_count_counts_error_events_not_exception_words(self):
        result = self.run_library(
            'log="$CEDAR_HOME/service.log"; '
            'printf "%s\\n" '
            '"WARN [ts] CedarCedarExceptionMapper: Folder not found" '
            '"java.lang.Exception: expected client outcome" '
            '"INFO [ts] service: recovered from earlier ERROR" '
            '"|-ERROR in ch.qos.logback.core: internal configuration chatter" '
            '"ERROR [ts] service: dependency failed" '
            '"ERROR [ts] service: second failure" > "$log"; '
            'log_error_count "$log"'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("2", result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
