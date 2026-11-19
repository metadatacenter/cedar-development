import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_docker_env as check


# What the configuration library declares for the fixture's components, as (required, optional).
DECLARED = {
    "user": ({"CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_VERSION", "CEDAR_USER_HTTP_PORT"},
             {"CEDAR_CORS_ALLOWED_ORIGINS"}),
    "worker": ({"CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_VERSION", "CEDAR_WORKER_HTTP_PORT",
                "CEDAR_LOG_MYSQL_HOST", "CEDAR_LOG_MYSQL_PASSWORD"}, set()),
    "resource": ({"CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_VERSION", "CEDAR_RESOURCE_HTTP_PORT"},
                 set()),
    "admin-tool": ({"CEDAR_HOST", "CEDAR_HOME", "CEDAR_MONGO_HOST", "CEDAR_MONGO_PORT",
                    "CEDAR_ADMIN_USER_PASSWORD"}, set()),
}

JAVA = """FROM eclipse-temurin:17.0.20_8-jre-ubi9-minimal
ENV LANG=C.UTF-8 \\
    LC_ALL=C.UTF-8
"""

MICROSERVICE = """# check=skip=InvalidDefaultArgInFrom
ARG CEDAR_IMAGE_PREFIX=metadatacenter
ARG CEDAR_DOCKER_VERSION
FROM ${CEDAR_IMAGE_PREFIX}/cedar-java:${CEDAR_DOCKER_VERSION}
ENV CEDAR_HOME=/cedar
ENV HOME=${CEDAR_HOME}
ARG CEDAR_MAVEN_VERSION
ENV CEDAR_VERSION=${CEDAR_MAVEN_VERSION}
ADD scripts/docker-entrypoint.sh ${CEDAR_HOME}/
ADD scripts/wait-for-dependencies.sh ${CEDAR_HOME}/
ADD scripts/wait-and-init-mysql.py ${CEDAR_HOME}/
ADD scripts/wait-for-mongodb.py ${CEDAR_HOME}/
ADD scripts/wait-for-keycloak.py ${CEDAR_HOME}/
ENV CEDAR_TRUSTSTORE=${CEDAR_HOME}/truststore/cacerts
CMD ["/cedar/docker-entrypoint.sh"]
"""

SCRIPTS = {
    "docker-entrypoint.sh": """#!/bin/bash
"${CEDAR_HOME}/wait-for-dependencies.sh" || exit 1
exec java ${CEDAR_JAVA_OPTS} -Djavax.net.ssl.trustStore="${CEDAR_TRUSTSTORE}" -jar /cedar/app/cedar-server.jar
""",
    "wait-for-dependencies.sh": """#!/bin/bash
# Waiting on another server used to go through CEDAR_MICROSERVICE_HOST, the Docker gateway.
wait_for() {
    if [ -n "${!2}" ]; then python3 -u "${CEDAR_HOME}/$3"; fi
}
python3 -u "${CEDAR_HOME}/wait-and-init-mysql.py"
wait_for Mongo      CEDAR_MONGO_HOST      wait-for-mongodb.py
wait_for Keycloak   CEDAR_KEYCLOAK_HOST   wait-for-keycloak.py
""",
    "wait-for-mongodb.py": """import os
host = os.environ.get('CEDAR_MONGO_HOST')
port = int(os.environ.get('CEDAR_MONGO_PORT'))
""",
    "wait-for-keycloak.py": """import os
host = os.environ.get('CEDAR_KEYCLOAK_HOST')
port = int(os.environ.get('CEDAR_KEYCLOAK_HTTP_PORT'))
""",
    "wait-and-init-mysql.py": """import os


def init_app_level_database(env_selector):
    host = os.environ.get('CEDAR_' + env_selector + '_MYSQL_HOST')
    password = os.environ.get('CEDAR_' + env_selector + '_MYSQL_PASSWORD')


root_password = os.environ.get('CEDAR_MYSQL_ROOT_PASSWORD')
cedar_server_name = os.environ.get('CEDAR_SERVER_NAME')

if cedar_server_name == "messaging":
    init_app_level_database('MESSAGING')
elif cedar_server_name == "worker":
    init_app_level_database('MESSAGING')
    init_app_level_database('LOG')
""",
}


def server_dockerfile(name, ports, extra=""):
    exposed = " ".join(f"${{{port}}}" for port in ports)
    defined = "".join(f"ENV {port}={9000 + index}\n" for index, port in enumerate(ports))
    return f"""ARG CEDAR_IMAGE_PREFIX=metadatacenter
ARG CEDAR_DOCKER_VERSION
FROM ${{CEDAR_IMAGE_PREFIX}}/cedar-microservice:${{CEDAR_DOCKER_VERSION}} AS cedar-runtime
FROM maven:3.9.11-eclipse-temurin-17 AS jarfetch
ENV CEDAR_SERVER_NAME={name}
ENV CEDAR_BUILD_STAGE_ONLY=1
RUN ${{CEDAR_HOME}}/install_deps.sh

FROM cedar-runtime
ENV CEDAR_SERVER_NAME={name}
{defined}{extra}EXPOSE {exposed}
"""


class CheckDockerEnvTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.build = root / "cedar-docker-build"
        self.compose = root / "cedar-microservices" / "docker-compose.yml"
        self.compose.parent.mkdir(parents=True)
        self.write(self.build / "cedar-java" / "Dockerfile", JAVA)
        self.write(self.build / "cedar-microservice" / "Dockerfile", MICROSERVICE)
        for name, text in SCRIPTS.items():
            self.write(self.build / "cedar-microservice" / "scripts" / name, text)
        self.dockerfiles = {
            "user": server_dockerfile("user", ["CEDAR_USER_HTTP_PORT"]),
            "worker": server_dockerfile("worker", ["CEDAR_WORKER_HTTP_PORT"]),
            "resource": server_dockerfile(
                "resource", ["CEDAR_RESOURCE_HTTP_PORT"], "ADD scripts/cedarat.sh ${CEDAR_HOME}/app\n"),
        }
        self.write(self.build / "cedar-server-resource" / "scripts" / "cedarat.sh",
                   '#!/bin/bash\njava -jar /cedar/app/cedar-admin-tool.jar "$@"\n')
        self.environment = {
            "server-user": ["CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_KEYCLOAK_HOST",
                            "CEDAR_KEYCLOAK_HTTP_PORT"],
            "server-worker": ["CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_LOG_MYSQL_HOST",
                              "CEDAR_LOG_MYSQL_PASSWORD", "CEDAR_MYSQL_ROOT_PASSWORD",
                              "CEDAR_MESSAGING_MYSQL_HOST", "CEDAR_MESSAGING_MYSQL_PASSWORD"],
            "server-resource": ["CEDAR_HOST", "CEDAR_NEO4J_HOST", "CEDAR_MONGO_HOST",
                                "CEDAR_MONGO_PORT", "CEDAR_ADMIN_USER_PASSWORD"],
        }

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def results(self):
        for name, text in self.dockerfiles.items():
            self.write(self.build / f"cedar-server-{name}" / "Dockerfile", text)
        lines = ["services:"]
        for service, names in self.environment.items():
            lines += [f"  {service}:", f"    container_name: {service}",
                      '    healthcheck:',
                      '      test: ["CMD-SHELL", "curl -sf http://localhost:9105/healthcheck || exit 1"]',
                      "    environment:"]
            lines += [f"      - {name}" for name in names]
        lines += ["networks:", "  cedarnet:", "    external: true", ""]
        self.write(self.compose, "\n".join(lines))
        stacks = [{"compose": self.compose, "service": r"server-([a-z]+)", "image": "cedar-server-{}"}]
        return {result.name: result for result in check.compare(DECLARED, stacks, self.build)}

    @staticmethod
    def reported(results):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = check.report(list(results.values()), verbose=True)
        return status, output.getvalue()

    def test_the_fixture_passes_in_both_directions(self):
        results = self.results()
        for result in results.values():
            with self.subTest(container=result.name):
                self.assertEqual("", result.problem)
                self.assertEqual([], result.missing)
                self.assertEqual([], result.surplus)
        status, output = self.reported(results)
        self.assertEqual(0, status, output)
        self.assertIn("every\nvariable they receive has a reader", output)

    def test_a_variable_the_code_requires_and_compose_omits_is_missing(self):
        self.environment["server-user"].remove("CEDAR_NEO4J_HOST")
        results = self.results()
        self.assertEqual(["CEDAR_NEO4J_HOST"], results["user"].missing)
        status, output = self.reported(results)
        self.assertEqual(1, status)
        self.assertIn("user               MISSING 1: CEDAR_NEO4J_HOST", output)

    def test_a_planted_surplus_variable_fails_the_run(self):
        self.environment["server-user"].append("CEDAR_SALT_API_KEY")
        results = self.results()
        self.assertEqual(["CEDAR_SALT_API_KEY"], results["user"].surplus)
        self.assertEqual([], results["user"].missing)
        status, output = self.reported(results)
        self.assertEqual(1, status)
        self.assertIn("user               SURPLUS 1: CEDAR_SALT_API_KEY", output)
        self.assertIn("1 container(s) receive a variable", output)

    def test_a_variable_set_by_an_image_env_line_can_be_surplus(self):
        self.dockerfiles["user"] = server_dockerfile(
            "user", ["CEDAR_USER_HTTP_PORT"], "ENV CEDAR_ARTIFACT_HTTP_PORT=9001\n")
        self.assertEqual(["CEDAR_ARTIFACT_HTTP_PORT"], self.results()["user"].surplus)

    def test_a_port_the_image_only_exposes_is_not_read(self):
        self.dockerfiles["user"] = server_dockerfile(
            "user", ["CEDAR_USER_HTTP_PORT", "CEDAR_USER_STOP_PORT"])
        self.assertEqual(["CEDAR_USER_STOP_PORT"], self.results()["user"].surplus)

    def test_a_comment_that_names_a_variable_is_not_a_reader(self):
        self.environment["server-user"].append("CEDAR_MICROSERVICE_HOST")
        self.assertEqual(["CEDAR_MICROSERVICE_HOST"], self.results()["user"].surplus)

    def test_variables_the_image_reads_are_kept_with_their_readers(self):
        self.environment["server-user"].append("CEDAR_JAVA_OPTS=-Dexample=true")
        user = self.results()["user"]
        self.assertEqual([], user.surplus)
        self.assertEqual(["cedar-microservice/scripts/docker-entrypoint.sh"], user.kept["CEDAR_JAVA_OPTS"])
        self.assertIn("cedar-microservice/Dockerfile", user.kept["CEDAR_HOME"])
        self.assertIn("cedar-microservice/scripts/docker-entrypoint.sh", user.kept["CEDAR_TRUSTSTORE"])

    def test_a_dependency_wait_reads_only_for_a_server_that_uses_the_backend(self):
        self.environment["server-user"] += ["CEDAR_MONGO_HOST", "CEDAR_MONGO_PORT"]
        user = self.results()["user"]
        self.assertEqual(["CEDAR_MONGO_HOST", "CEDAR_MONGO_PORT"], user.surplus)
        # No component declares the Keycloak gate, and WAITS_WITHOUT_DECLARATION keeps its wait.
        self.assertIn("CEDAR_KEYCLOAK_HOST", check.WAITS_WITHOUT_DECLARATION)
        self.assertEqual(["cedar-microservice/scripts/wait-for-keycloak.py"],
                         user.kept["CEDAR_KEYCLOAK_HTTP_PORT"])

    def test_a_server_that_starts_the_admin_tool_must_satisfy_it(self):
        resource = self.results()["resource"]
        self.assertEqual([], resource.surplus)
        self.assertIn(
            "declared by admin-tool (started by cedar-server-resource/scripts/cedarat.sh)",
            resource.kept["CEDAR_ADMIN_USER_PASSWORD"])
        self.environment["server-resource"].remove("CEDAR_MONGO_PORT")
        self.assertEqual(["CEDAR_MONGO_PORT"], self.results()["resource"].missing)

    def test_mysql_initialization_reads_only_for_the_servers_it_names(self):
        worker = self.results()["worker"]
        self.assertEqual([], worker.surplus)
        self.assertIn("CEDAR_MESSAGING_MYSQL_HOST", worker.kept)
        self.assertIn("CEDAR_MYSQL_ROOT_PASSWORD", worker.kept)
        self.environment["server-user"] += ["CEDAR_MYSQL_ROOT_PASSWORD", "CEDAR_MESSAGING_MYSQL_HOST"]
        self.assertEqual(["CEDAR_MESSAGING_MYSQL_HOST", "CEDAR_MYSQL_ROOT_PASSWORD"],
                         self.results()["user"].surplus)

    def test_only_the_final_stage_and_its_bases_give_the_container_environment(self):
        self.results()
        image = check.Image(self.build, "cedar-server-user")
        self.assertEqual("user", image.env["CEDAR_SERVER_NAME"])
        self.assertEqual("/cedar", image.env["CEDAR_HOME"])
        self.assertEqual("C.UTF-8", image.env["LC_ALL"])
        self.assertNotIn("CEDAR_BUILD_STAGE_ONLY", image.env)

    def test_an_unknown_container_or_missing_image_is_not_passed(self):
        self.environment["server-unknown"] = ["CEDAR_HOST"]
        self.dockerfiles.pop("user")
        results = self.results()
        self.assertEqual("no SystemComponent named this container", results["unknown"].problem)
        self.assertIn("no Dockerfile", results["user"].problem)
        self.assertEqual(1, self.reported(results)[0])


class ParsingTest(unittest.TestCase):
    def test_compose_environment_in_list_and_map_form_and_the_health_check(self):
        with tempfile.TemporaryDirectory() as directory:
            compose = Path(directory) / "docker-compose.yml"
            compose.write_text("""services:
  database:
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -p\\"$$CEDAR_MYSQL_ROOT_PASSWORD\\" --silent"]
    environment:
      - CEDAR_BARE
      - CEDAR_JAVA_OPTS=-Done=${CEDAR_INTERPOLATED}
        -Dtwo=${CEDAR_ALSO_INTERPOLATED}
      - "CEDAR_QUOTED=value"
      # - CEDAR_COMMENTED_OUT
    extra_hosts:
      - "auth.${CEDAR_HOST}:${CEDAR_AUTH_HOST_TARGET}"
  frontend:
    environment:
      CEDAR_HOST: "${CEDAR_HOST}"
      CEDAR_URL: "${CEDAR_URL:-https://example.org}"
volumes:
  database:
    name: database
""", encoding="utf-8")
            database = check.compose_services(compose, r"(database)")["database"]
            frontend = check.compose_services(compose, r"(frontend)")["frontend"]
        self.assertEqual({"CEDAR_BARE", "CEDAR_JAVA_OPTS", "CEDAR_QUOTED"}, database["environment"])
        self.assertEqual(["CEDAR_MYSQL_ROOT_PASSWORD"],
                         check.COMPOSE_CONTAINER_REFERENCE.findall(database["healthcheck"]))
        self.assertEqual({"CEDAR_HOST", "CEDAR_URL"}, frontend["environment"])

    def test_env_instructions_in_every_form(self):
        self.assertEqual([("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8")],
                         check.env_assignments("LANG=C.UTF-8 LC_ALL=C.UTF-8"))
        self.assertEqual([("GOSU_VERSION", "1.12")], check.env_assignments("GOSU_VERSION 1.12"))
        self.assertEqual([("PATH", "$VIRTUAL_ENV/bin:$PATH")],
                         check.env_assignments('PATH="$VIRTUAL_ENV/bin:$PATH"'))

    def test_a_name_a_script_assembles_is_not_a_variable(self):
        names = check.names_in(
            'name="CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_${suffix}"\n'
            "host = os.environ.get('CEDAR_' + selector + '_MYSQL_HOST')\n")
        self.assertEqual({"CEDAR_FRONTEND_TARGET"}, names)


if __name__ == "__main__":
    unittest.main()
