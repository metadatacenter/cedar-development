import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "cedar-services.sh"
DEVELOPMENT = Path(__file__).resolve().parents[2]


def a_jdk_reporting(directory, first_line):
    """A JAVA_HOME whose java says what the caller wants it to say."""
    binaries = Path(directory) / "bin"
    binaries.mkdir(parents=True, exist_ok=True)
    java = binaries / "java"
    java.write_text("#!/bin/bash\nprintf '%s\\n' \"$1 is not read\" >/dev/null\n"
                    f"printf '%s\\n' '{first_line}' >&2\n")
    java.chmod(0o755)
    return str(directory)


class NativeProcessSafetyTest(unittest.TestCase):

    # The controller requires a JDK 17, so the suite carries one rather than borrowing whatever the
    # machine happens to have. Without this the tests pass only where a JDK is already installed and
    # exported, which is a CI runner and a developer's own workstation, and nowhere else.
    @classmethod
    def setUpClass(cls):
        cls._java_home = tempfile.TemporaryDirectory()
        cls.java_home = a_jdk_reporting(cls._java_home.name, 'openjdk version "17.0.9" 2023-10-17')

    @classmethod
    def tearDownClass(cls):
        cls._java_home.cleanup()

    def run_library(self, body, **overrides):
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
                "JAVA_HOME": self.java_home,
                **overrides,
            }
            return subprocess.run(
                ["bash", "-c", 'source "$1"; eval "$2"', "test", str(SCRIPT), body],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    def a_jdk_reporting(self, directory, first_line):
        return a_jdk_reporting(directory, first_line)

    def test_a_java_home_with_no_java_in_it_is_refused(self):
        """Only $JAVA_HOME/bin joins PATH, so an unusable one leaves java coming from elsewhere."""
        with tempfile.TemporaryDirectory() as empty:
            result = self.run_library("true", JAVA_HOME=empty)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("has no java to run", result.stderr)
            self.assertIn(empty, result.stderr)

    def test_a_java_home_on_the_wrong_jdk_is_refused_by_version(self):
        with tempfile.TemporaryDirectory() as directory:
            home = self.a_jdk_reporting(directory, 'openjdk version "21.0.2" 2024-01-16')
            result = self.run_library("true", JAVA_HOME=home)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("CEDAR needs JDK 17", result.stderr)
            self.assertIn("reports 21", result.stderr)

    def test_a_java_home_that_reports_no_version_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            home = self.a_jdk_reporting(directory, "not a version at all")
            result = self.run_library("true", JAVA_HOME=home)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("no version this can read", result.stderr)

    def test_a_java_home_on_jdk_17_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            home = self.a_jdk_reporting(directory, 'openjdk version "17.0.9" 2023-10-17')
            result = self.run_library("echo controller loaded", JAVA_HOME=home)

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("controller loaded", result.stdout)

    def test_the_legacy_jdk_version_spelling_is_read_as_its_major(self):
        """A pre-9 JDK says 1.8.0_202, and reading that as 1 would accept it."""
        with tempfile.TemporaryDirectory() as directory:
            home = self.a_jdk_reporting(directory, 'java version "1.8.0_202"')
            result = self.run_library("true", JAVA_HOME=home)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("reports 8", result.stderr)

    # These say what the controller has to be able to do, not which system it is doing it on, so
    # each runner in the CI matrix supplies a platform and the same assertions cover both. They use
    # the real tools with nothing stubbed, which is the only way a command that is valid on one
    # system and rejected by the other gets caught.

    def test_port_open_sees_a_port_that_is_listening(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            result = self.run_library(f"port_open {port} && echo listening || echo silent")

            self.assertEqual("listening", result.stdout.strip(), result.stderr)

    def test_port_open_sees_a_port_that_is_not(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        # The socket is closed, so nothing holds the port and the answer has to be no.
        result = self.run_library(f"port_open {port} && echo listening || echo silent")

        self.assertEqual("silent", result.stdout.strip(), result.stderr)

    def test_port_owner_names_the_process_holding_the_port(self):
        """What keeps stop from signalling a listener that is not CEDAR, so it has to be right."""
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            result = self.run_library(f"port_owner {port}")

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(str(os.getpid()), result.stdout.strip())

    def test_file_mtime_reads_the_modification_time_as_a_number(self):
        with tempfile.TemporaryDirectory() as directory:
            written = Path(directory) / "artifact.jar"
            written.write_text("")
            expected = int(written.stat().st_mtime)
            result = self.run_library(f'file_mtime "{written}"')

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertRegex(result.stdout.strip(), r"^\d+$")
            self.assertLessEqual(abs(int(result.stdout.strip()) - expected), 1)

    def test_process_start_epoch_reads_a_live_process_as_a_number(self):
        result = self.run_library("process_start_epoch $$")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^\d+$")
        # A shell started moments ago, not the epoch and not the future.
        self.assertLess(abs(int(result.stdout.strip()) - time.time()), 600)

    def test_a_stale_jar_is_recognized_against_the_running_process(self):
        """The whole point of the BINARY column, and it rests on the two readings above agreeing."""
        with tempfile.TemporaryDirectory() as directory:
            jar = Path(directory) / "cedar-group-server-application-2.9.3-SNAPSHOT.jar"
            jar.write_text("")
            os.utime(jar, (time.time() + 3600, time.time() + 3600))
            result = self.run_library(
                f'jar_of() {{ echo "{jar}"; }}; binary_of group $$')

            self.assertEqual("STALE", result.stdout.strip(), result.stderr)

    @staticmethod
    def _cee_frontend(root, repository, wanted, installed, served=None):
        """A frontend checkout whose lock names one Editor and whose node_modules holds another."""
        checkout = Path(root) / repository
        module = checkout / "node_modules" / "cedar-embeddable-editor"
        served_dir = checkout / "app" / "third_party_components" / "cedar-embeddable-editor"
        module.mkdir(parents=True)
        served_dir.mkdir(parents=True)
        (checkout / "package-lock.json").write_text(json.dumps({
            "packages": {"node_modules/cedar-embeddable-editor": {"version": wanted}},
        }), encoding="utf-8")
        (module / "package.json").write_text(json.dumps({"version": installed}), encoding="utf-8")
        (module / "cedar-embeddable-editor.js").write_text(f"// editor {installed}\n", encoding="utf-8")
        (served_dir / "cedar-embeddable-editor.js").write_text(
            f"// editor {served or installed}\n", encoding="utf-8")

    def test_a_moved_editor_pin_without_a_reinstall_marks_both_frontends_stale(self):
        """The lock moved to a new Editor and npm ci never ran, in the monolith and in Workspace."""
        with tempfile.TemporaryDirectory() as directory:
            self._cee_frontend(directory, "cedar-template-editor", "2.0.6", "2.0.5")
            self._cee_frontend(directory, "cedar-workspace", "2.0.6", "2.0.5")
            result = self.run_library(
                'printf "%s %s %s\n" "$(binary_of ui-main 1)" "$(binary_of ui-workspace 1)" '
                '"$(binary_of ui-designer 1)"',
                CEDAR_HOME=directory,
            )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("STALE STALE -", result.stdout.strip())

    def test_a_reinstalled_editor_that_was_never_copied_is_stale_in_its_own_frontend(self):
        with tempfile.TemporaryDirectory() as directory:
            self._cee_frontend(directory, "cedar-template-editor", "2.0.6", "2.0.6")
            self._cee_frontend(directory, "cedar-workspace", "2.0.6", "2.0.6", served="2.0.5")
            result = self.run_library(
                'printf "%s %s\n" "$(binary_of ui-main 1)" "$(binary_of ui-workspace 1)"',
                CEDAR_HOME=directory,
            )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("current STALE", result.stdout.strip())

    def test_only_the_frontends_that_embed_the_editor_are_asked_about_it(self):
        result = self.run_library(
            'for name in ui-main ui-workspace ui-designer ui-openview group; do '
            'if serves_cee "$name"; then printf "%s " "$name"; fi; done; echo')

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("ui-main ui-workspace", result.stdout.strip())

    def test_docker_port_proxy_is_not_a_native_microservice(self):
        result = self.run_library(
            'process_command() { echo "/Applications/Docker.app/Contents/MacOS/com.docker.backend"; }; '
            'process_cwd() { echo "/"; }; '
            'is_service_process group 4242'
        )

        self.assertNotEqual(0, result.returncode)

    def test_process_details_come_from_a_real_platform_process(self):
        """Exercise ps and lsof on both Linux and macOS instead of replacing them."""
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen(["sleep", "30"], cwd=directory)
            try:
                result = self.run_library(
                    f'printf "command=%s\\ncwd=%s\\n" '
                    f'"$(process_command {process.pid})" "$(process_cwd {process.pid})"'
                )
            finally:
                process.terminate()
                process.wait(timeout=5)

        self.assertEqual(0, result.returncode, result.stderr)
        if "command=\n" in result.stdout and os.environ.get("CODEX_SANDBOX"):
            self.skipTest("the test sandbox does not permit ps process inspection")
        self.assertIn("sleep 30", result.stdout)
        self.assertIn(f"cwd={Path(directory).resolve()}", result.stdout)

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
            'process_alive() { return 0; }; '
            'launchctl() { printf "%s\\n" "$*"; }; '
            'start_one group'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("submit -l org.metadatacenter.cedar.native.group", result.stdout)
        self.assertIn("-- /bin/bash -c", result.stdout)
        self.assertIn('exec "$3" run-one "$4"', result.stdout)
        self.assertIn(f"develop {SCRIPT} group", result.stdout)
        self.assertIn("started group (pid 4242)", result.stdout)

    def test_linux_start_uses_the_background_launcher_and_not_launchd(self):
        """The other half of the branch above, which no test reached while every test said Darwin."""
        result = self.run_library(
            'base="$CEDAR_HOME/cedar-group-server/cedar-group-server-application"; '
            'mkdir -p "$base/target" "$base/src/main/resources"; '
            'touch "$base/target/cedar-group-server-application-$CEDAR_VERSION.jar"; '
            'touch "$base/src/main/resources/config.yml"; '
            'port_open() { return 1; }; uname() { echo Linux; }; '
            # Stands in for the launched service: backgrounded by the script, so $! is a live pid.
            'nohup() { sleep 2; }; '
            'launchctl() { echo "launchctl reached on Linux: $*"; }; '
            'start_one group'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("started group", result.stdout)
        self.assertNotIn("launchctl reached on Linux", result.stdout)
        self.assertNotIn("submit -l", result.stdout)

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
            'process_alive() { return 0; }; '
            'launchctl() { printf "%s\\n" "$*"; }; '
            'start_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("CEDAR_PROFILE is not set", result.stderr)
        self.assertNotIn("submit -l", result.stdout)

    def test_start_reports_a_service_that_exits_at_once_rather_than_starting_it(self):
        """A submitted job restarts on exit, so a PID alone never proves a service runs."""
        result = self.run_library(
            'base="$CEDAR_HOME/cedar-group-server/cedar-group-server-application"; '
            'mkdir -p "$base/target" "$base/src/main/resources"; '
            'touch "$base/target/cedar-group-server-application-$CEDAR_VERSION.jar"; '
            'touch "$base/src/main/resources/config.yml"; '
            'port_open() { return 1; }; uname() { echo Darwin; }; '
            'remove_launchd_job() { echo "removed $1"; }; launchd_job_pid() { echo 4242; }; '
            'process_alive() { return 1; }; '
            # start_one truncates the log before submitting, so the child's message has to land
            # after that, which is where a real service writes it.
            'launchctl() { printf "%s\\n" "$*"; '
            'echo "Cannot load native CEDAR profile" >> "$(logfile group)"; }; '
            'start_one group'
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("exited immediately (pid 4242)", result.stderr)
        self.assertIn("Cannot load native CEDAR profile", result.stderr)
        self.assertNotIn("started group", result.stdout)
        self.assertIn("removed group", result.stdout)

    def test_logs_resolves_the_two_logs_a_service_writes(self):
        result = self.run_library(
            'echo "stdout:$(logfile terminology)"; '
            'echo "appender:$(dropwizard_logfile terminology)"; '
            'echo "frontend:$(dropwizard_logfile ui-main)"'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("stdout:", result.stdout)
        self.assertIn("/log/cedar-terminology-server.log", result.stdout)
        self.assertIn("/log/cedar-terminology-server/dropwizard.log", result.stdout)
        # A frontend declares no appender, so there is no second log to offer for one.
        self.assertIn("frontend:\n", result.stdout)

    def test_the_dropwizard_log_is_where_the_service_config_says_it_is(self):
        """The controller derives this path; each service's config.yml is what actually sets it."""
        config = (DEVELOPMENT.parent / "cedar-terminology-server"
                  / "cedar-terminology-server-application"
                  / "src/main/resources/config.yml")
        if not config.is_file():
            self.skipTest("cedar-terminology-server is not checked out beside cedar-development")
        declared = [line.split("currentLogFilename:")[1].strip()
                    for line in config.read_text().splitlines()
                    if "currentLogFilename:" in line]

        result = self.run_library('dropwizard_logfile terminology')

        self.assertEqual(0, result.returncode, result.stderr)
        derived = result.stdout.strip()
        expected = declared[0].replace("${CEDAR_HOME}", os.environ.get("CEDAR_HOME", ""))
        self.assertEqual(Path(expected).name, Path(derived).name)
        self.assertEqual(Path(expected).parent.name, Path(derived).parent.name)

    def test_logs_refuses_a_service_it_does_not_manage(self):
        result = self.run_library('follow_log bogus')

        self.assertEqual(2, result.returncode)
        self.assertIn("unknown service 'bogus'", result.stderr)

    def test_logs_refuses_a_dropwizard_log_no_frontend_writes(self):
        result = self.run_library('follow_log ui-main --dropwizard')

        self.assertEqual(2, result.returncode)
        self.assertIn("declares no Dropwizard appender", result.stderr)

    def test_logs_refuses_a_line_count_that_is_not_a_number(self):
        result = self.run_library('follow_log terminology -n twenty')

        self.assertEqual(2, result.returncode)
        self.assertIn("--lines takes a number", result.stderr)

    def test_logs_refuses_more_than_the_one_log_it_can_follow(self):
        result = self.run_library('follow_log terminology user')

        self.assertEqual(2, result.returncode)
        self.assertIn("follows one service", result.stderr)

    def test_logs_says_which_log_is_missing_rather_than_following_nothing(self):
        # The harness CEDAR_HOME is empty, so no service has written a log into it.
        result = self.run_library('follow_log terminology')

        self.assertEqual(1, result.returncode)
        self.assertIn("has written no log yet at", result.stderr)
        self.assertIn("cedar-terminology-server.log", result.stderr)

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

    def test_angular_frontends_clear_generated_cache_and_prefer_their_local_cli(self):
        script = SCRIPT.read_text()

        self.assertIn('ng="./node_modules/.bin/ng"', script)
        self.assertIn('[ -x "$ng" ] || ng=$(command -v ng)', script)
        self.assertIn('"$ng" cache clean || return 1', script)
        self.assertIn('exec "$ng" serve --port "$app"', script)

    def test_frontend_health_rejects_a_listening_failed_compiler(self):
        result = self.run_library(
            'app_port() { echo 4220; }; admin_port() { echo 0; }; '
            'curl() { printf 404; }; port_open() { return 0; }; '
            'health_of ui-openview'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("UNHEALTHY", result.stdout.strip())

    def test_frontend_health_accepts_a_served_application(self):
        result = self.run_library(
            'app_port() { echo 4220; }; admin_port() { echo 0; }; '
            'curl() { printf 200; }; port_open() { return 0; }; '
            'health_of ui-openview'
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("healthy", result.stdout.strip())

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
