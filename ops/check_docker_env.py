#!/usr/bin/env python3
"""Check that every Docker microservice gets the environment its code requires, and nothing unused.

A CEDAR server declares what it needs in code. CedarConfigEnvironmentDescriptor maps each
SystemComponent to a set of CedarEnvironmentVariable, and CedarEnvironmentVariableProvider builds
the configuration sandbox from it: a variable the server needs but does not get is fatal at
startup, while one it does not need is defaulted (0 for numerics, false for booleans) or held back.
That asymmetry is why most absent variables are harmless and a few stop the server dead. A
variable the descriptor declares optional is read when present and defaulted when absent, so
it is not required here.

Nothing connected that declaration to the compose files, so four servers shipped unable to start.
This asks the code for the answer rather than reading the descriptor by eye: it runs jshell against
cedar-config-library and compares the result with what each container actually receives, which is
the union of the compose environment list and the ENV lines the image inherits. Only the image's
final build stage, and the stages and CEDAR base images it is built FROM, contribute ENV.

The comparison runs in both directions. A container missing a variable it needs stops at startup.
A container can also receive a variable that its code does not declare and its image does not
read. The sandbox drops such a variable, so setting it changes nothing. Five servers kept receiving
the Docker gateway's address for three months after the wait that read it was removed. What an
image reads is derived from every Dockerfile it is built from, the build-context files those add,
and the compose health check, which runs inside the container. The derivation follows three rules.

  - A reference in an EXPOSE instruction is not a read. EXPOSE documents a port and changes
    nothing that runs, so a port nothing listens on is still reported.
  - A dependency wait in wait-for-dependencies.sh runs only when its gate variable is set. It reads
    a backend's coordinates because the container was given them, so its reads count only for a
    container whose components declare the gate, or for a gate in WAITS_WITHOUT_DECLARATION.
  - A script that branches on CEDAR_SERVER_NAME, as wait-and-init-mysql.py does, reads its
    variables only for the servers it names. It builds some names from parts, and those are
    derived from the script.

When an image's scripts start a CEDAR tool, as the resource server's first-run bootstrap starts the
admin tool, the check holds the container to that tool's declarations as well, in both directions.

Both directions fail the run. A surplus variable never stops a container, but it is either a
setting an operator believes takes effect or a secret handed to a container with no use for it,
and a finding that does not fail the run goes unread.

    ops/check_docker_env.py                # uses built jars or artifacts from the local Maven repo
    ops/check_docker_env.py --jar PATH     # or a config-library jar you point it at
    ops/check_docker_env.py --verbose      # also name what reads each undeclared variable kept

Exits non-zero if any container is missing a variable it needs or receives one nothing reads.
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

CEDAR_HOME = Path(os.environ.get("CEDAR_HOME", Path.home() / "CEDAR"))
BUILD = CEDAR_HOME / "cedar-docker-build"
DEPLOY = CEDAR_HOME / "cedar-docker-deploy"

# Every stack holding containers whose configuration cedar-main.yml builds, with the compose
# service names it declares and the image each service runs. The admin tool is here because it
# reads the same configuration and stops on the same absent variable, and it was left unchecked
# long enough to ship unable to start. Base images are found from each Dockerfile's FROM lines.
STACKS = [
    {
        "compose": DEPLOY / "cedar-microservices" / "docker-compose.yml",
        "service": r"server-([a-z]+)",
        "image": "cedar-server-{}",
    },
    {
        "compose": DEPLOY / "cedar-admin" / "docker-compose.yml",
        "service": r"(admin-tool)",
        "image": "cedar-{}",
    },
]

# Gates whose wait every container keeps although no component declares the gate, each with the
# reason the container still depends on that backend.
WAITS_WITHOUT_DECLARATION = {
    "CEDAR_KEYCLOAK_HOST": (
        "every server verifies bearer tokens against the CEDAR realm, which it reaches as "
        "auth.<host> rather than through these variables, so the base image holds each server "
        "back until Keycloak answers"
    ),
}

# The CEDAR tools an image can start beside its server, by the jar a script runs. A tool builds
# its own configuration from the container's environment, as the component named here.
EMBEDDED_TOOLS = {
    "cedar-admin-tool.jar": "admin-tool",
}

DUMP = """
import org.metadatacenter.config.environment.*;
import org.metadatacenter.model.SystemComponent;
for (SystemComponent c : SystemComponent.values()) {
  var required = new java.util.TreeSet<String>();
  var optional = new java.util.TreeSet<String>();
  for (var v : CedarConfigEnvironmentDescriptor.getVariableNamesFor(c)) {
    (v.isOptional() ? optional : required).add(v.getName());
  }
  System.out.println("DECL\\t" + c.getStringValue() + "\\t" + String.join(",", required)
      + "\\t" + String.join(",", optional));
}
/exit
"""

# A whole variable name. The lookarounds refuse a fragment of a name a script assembles, such as
# the CEDAR_FRONTEND_ of CEDAR_FRONTEND_${target}_UI_HOST.
NAME = re.compile(r"(?<![A-Za-z0-9_])CEDAR_[A-Za-z0-9_]*[A-Za-z0-9](?![A-Za-z0-9_$])")
DOCKER_REFERENCE = re.compile(r"\$\{?(CEDAR_[A-Za-z0-9_]*[A-Za-z0-9])")
COMPOSE_CONTAINER_REFERENCE = re.compile(r"\$\$\{?(CEDAR_[A-Za-z0-9_]*[A-Za-z0-9])")
INTERNAL_IMAGE = re.compile(r"(?:^|/)(cedar-[a-z0-9-]+):")
WAIT_LINE = re.compile(r"^[ \t]*wait_for[ \t]+\S+[ \t]+(CEDAR_[A-Z0-9_]+)[ \t]+(\S+)[ \t]*$", re.M)
SERVER_BRANCH = re.compile(
    r"""cedar_server_name\s*==\s*["'](\w+)["']\s*:[ \t]*\n((?:[ \t]+\S.*(?:\n|$))+)""")
JOINED_SUFFIX = re.compile(r"""["']CEDAR_["']\s*\+\s*\w+\s*\+\s*["'](_[A-Z0-9_]+)["']""")
LITERAL_ARGUMENT = re.compile(r"""\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)""")


def find_jar(pattern, explicit=None):
    if explicit:
        return Path(explicit)
    for root in (CEDAR_HOME / "cedar-config-library" / "target",
                 CEDAR_HOME / "cedar-core-library" / "target",
                 Path.home() / ".m2" / "repository"):
        hits = [p for p in root.rglob(pattern) if "sources" not in p.name and "original" not in p.name]
        if hits:
            return sorted(hits)[-1]
    return None


def declarations(config_jar, core_jar):
    """Ask the code what each component declares: {component: (required, optional)}."""
    java_home = os.environ.get("JAVA_HOME", "")
    jshell = Path(java_home, "bin", "jshell") if java_home else Path("jshell")
    cp = f"{config_jar}:{core_jar}"
    proc = subprocess.run([str(jshell), "--class-path", cp, "-q", "-"],
                          input=DUMP, capture_output=True, text=True)
    out = {}
    for line in proc.stdout.splitlines():
        if line.startswith("DECL\t"):
            _, component, required, optional = (line.split("\t") + [""])[:4]
            out[component.lower()] = (set(filter(None, required.split(","))),
                                      set(filter(None, optional.split(","))))
    if not out:
        sys.exit(f"jshell returned no declarations.\n{proc.stdout}\n{proc.stderr}")
    return out


def instructions(dockerfile):
    """A Dockerfile's instructions as (keyword, arguments), read as Docker reads them: comment
    lines dropped, including those inside a continued instruction, and continuations joined."""
    result, pending = [], ""
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#"):
            continue
        if line.rstrip().endswith("\\"):
            pending += line.rstrip()[:-1] + " "
            continue
        logical, pending = (pending + line).strip(), ""
        if logical:
            keyword, _, arguments = logical.partition(" ")
            result.append((keyword.upper(), arguments.strip()))
    if pending.strip():
        keyword, _, arguments = pending.strip().partition(" ")
        result.append((keyword.upper(), arguments.strip()))
    return result


def stages(dockerfile):
    """Each build stage of a Dockerfile: what it is built FROM, its name, and its instructions.
    Instructions before the first FROM declare build arguments and belong to no stage."""
    found = []
    for keyword, arguments in instructions(dockerfile):
        if keyword == "FROM":
            words = [word for word in arguments.split() if not word.startswith("--")]
            name = words[2].lower() if len(words) >= 3 and words[1].upper() == "AS" else None
            found.append({"from": words[0] if words else "", "name": name, "instructions": []})
        elif found:
            found[-1]["instructions"].append((keyword, arguments))
    return found


def env_assignments(arguments):
    """The (name, value) pairs one ENV instruction sets, in the NAME=value or the NAME value form."""
    try:
        words = shlex.split(arguments)
    except ValueError:
        words = arguments.split()
    if not words:
        return []
    if "=" not in words[0]:
        return [(words[0], " ".join(words[1:]))]
    return [tuple(word.split("=", 1)) for word in words if "=" in word]


def added_files(dockerfile, stage_list):
    """The build-context files a Dockerfile's ADD and COPY instructions put into the image. A copy
    from another stage or image is left out, because its files belong to whatever built them."""
    context, files = dockerfile.parent, []
    for stage in stage_list:
        for keyword, arguments in stage["instructions"]:
            if keyword not in ("ADD", "COPY"):
                continue
            if arguments.startswith("["):
                try:
                    words = json.loads(arguments)
                except ValueError:
                    continue
            else:
                words = arguments.split()
            if any(word.startswith("--from=") for word in words):
                continue
            sources = [word for word in words if not word.startswith("--")][:-1]
            for source in sources:
                if "://" in source:
                    continue
                matches = sorted(context.glob(source)) if any(c in source for c in "*?[") \
                    else [context / source]
                for path in matches:
                    if path.is_dir():
                        files.extend(p for p in sorted(path.rglob("*")) if p.is_file())
                    elif path.is_file():
                        files.append(path)
    return files


class Image:
    """The environment one image gives its container, and the files it reads that environment with.

    The ENV a container inherits comes from the image's final stage and the stages and CEDAR base
    images that stage is built FROM. The image's reads come from every Dockerfile it is built from,
    in every stage, and from every build-context file those Dockerfiles add.
    """

    def __init__(self, build, name):
        self.build = build
        self.name = name
        self.dockerfile = build / name / "Dockerfile"
        self.env = {}
        self.dockerfile_reads = {}
        self.files = []
        chain = self._lineage(name, set())
        for stage in reversed(chain):
            for keyword, arguments in stage["instructions"]:
                if keyword == "ENV":
                    self.env.update(env_assignments(arguments))

    def _lineage(self, name, seen):
        """The stages the named image's final stage is built from, that stage first."""
        dockerfile = self.build / name / "Dockerfile"
        if name in seen or not dockerfile.exists():
            return []
        seen.add(name)
        stage_list = stages(dockerfile)
        reads = set()
        for stage in stage_list:
            reads.update(DOCKER_REFERENCE.findall(stage["from"]))
            for keyword, arguments in stage["instructions"]:
                if keyword != "EXPOSE":
                    reads.update(DOCKER_REFERENCE.findall(arguments))
        self.dockerfile_reads[dockerfile] = reads
        self.files.extend(added_files(dockerfile, stage_list))
        named = {stage["name"]: stage for stage in stage_list if stage["name"]}
        chain, stage, visited = [], stage_list[-1] if stage_list else None, set()
        while stage is not None and id(stage) not in visited:
            visited.add(id(stage))
            chain.append(stage)
            base = stage["from"].lower()
            if base in named:
                stage = named[base]
                continue
            internal = INTERNAL_IMAGE.search(stage["from"])
            if internal:
                chain.extend(self._lineage(internal.group(1), seen))
            stage = None
        return chain


def script_text(path):
    """A file's text without its comment lines and trailing comments, or nothing if it is not text."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    kept = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        kept.append(re.sub(r"\s#\s.*$", "", line))
    return "\n".join(kept) + "\n"


def names_in(text):
    return set(NAME.findall(text))


def embedded_tools(image):
    """The CEDAR tools the image's scripts start, each with the file that starts it."""
    tools = {}
    for path in image.files:
        text = script_text(path)
        for jar, component in EMBEDDED_TOOLS.items():
            if re.search(rf"-jar\s+\S*{re.escape(jar)}", text):
                tools.setdefault(component, path.relative_to(image.build).as_posix())
    return tools


def image_reads(image, uses, server, healthcheck):
    """Each variable the image reads for one container, with the files that read it.

    `uses` is every variable the container's components declare, which says which backends its
    dependency waits are for. `server` is the CEDAR_SERVER_NAME the image sets.
    """
    reads = {}

    def add(names, reader):
        for name in names:
            reads.setdefault(name, set()).add(reader)

    for dockerfile, names in image.dockerfile_reads.items():
        add(names, dockerfile.relative_to(image.build).as_posix())
    add(COMPOSE_CONTAINER_REFERENCE.findall(healthcheck), "compose health check")
    texts = {path: script_text(path) for path in image.files}
    gates = {script: gate for text in texts.values() for gate, script in WAIT_LINE.findall(text)}
    for path, text in texts.items():
        reader = path.relative_to(image.build).as_posix()
        gate = gates.get(path.name)
        if gate is not None:
            if gate in uses or gate in WAITS_WITHOUT_DECLARATION:
                add(names_in(text) | {gate}, reader)
            continue
        branches = SERVER_BRANCH.findall(text)
        if branches:
            add(names_in(text) & {"CEDAR_SERVER_NAME"}, reader)
            suffixes = JOINED_SUFFIX.findall(text)
            for name, block in branches:
                if name == server:
                    selectors = LITERAL_ARGUMENT.findall(block)
                    add(names_in(text), reader)
                    add({f"CEDAR_{selector}{suffix}" for selector in selectors for suffix in suffixes},
                        reader)
            continue
        add(names_in(WAIT_LINE.sub("", text)), reader)
    return reads


def compose_services(compose, service_pattern):
    """For each compose service whose name matches, the CEDAR_ variables its environment section
    passes, in list or map form, and its health check command."""
    if not compose.exists():
        sys.exit(f"Compose file not found: {compose}")
    services, current, in_services, in_environment = {}, None, False, False
    for raw in compose.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if indent == 0:
            in_services, current = line == "services:", None
            continue
        if indent == 2:
            match = re.fullmatch(service_pattern + ":", line) if in_services else None
            current = services.setdefault(match.group(1), {"environment": set(), "healthcheck": ""}) \
                if match else None
            in_environment = False
            continue
        if current is None:
            continue
        if indent == 4:
            in_environment = line == "environment:"
            continue
        if in_environment and indent == 6:
            entry = line[2:].strip().strip("'\"") if line.startswith("- ") else line
            name = re.match(r"(CEDAR_[A-Za-z0-9_]+)\s*(?:[=:]|$)", entry)
            if name:
                current["environment"].add(name.group(1))
        elif line.startswith("test:"):
            current["healthcheck"] += line[len("test:"):].strip()
    return services


@dataclass
class Result:
    name: str
    problem: str = ""
    required: int = 0
    missing: list = field(default_factory=list)
    surplus: list = field(default_factory=list)
    kept: dict = field(default_factory=dict)


def compare(declared, stacks, build):
    """Compare what each container receives with what its code declares and its image reads."""
    results = []
    for stack in stacks:
        services = compose_services(stack["compose"], stack["service"])
        if not services:
            results.append(Result(stack["compose"].parent.name, "declares no services to check"))
            continue
        for service in sorted(services):
            if service not in declared:
                results.append(Result(service, "no SystemComponent named this container"))
                continue
            image = Image(build, stack["image"].format(service))
            if not image.dockerfile.exists():
                results.append(Result(service, f"no Dockerfile at {image.dockerfile}"))
                continue
            tools = {component: starter for component, starter in embedded_tools(image).items()
                     if component != service and component in declared}
            components = [service] + sorted(tools)
            required = set().union(*(declared[c][0] for c in components))
            uses = set().union(*(declared[c][0] | declared[c][1] for c in components))
            own = declared[service][0] | declared[service][1]
            given = {name for name in services[service]["environment"] | set(image.env)
                     if NAME.fullmatch(name)}
            reads = image_reads(image, uses, image.env.get("CEDAR_SERVER_NAME", service),
                                services[service]["healthcheck"])
            kept = {}
            for name in sorted(given - own):
                readers = {f"declared by {c} (started by {tools[c]})" for c in tools
                           if name in declared[c][0] | declared[c][1]}
                readers |= reads.get(name, set())
                if readers:
                    kept[name] = sorted(readers)
            results.append(Result(
                service,
                required=len(required),
                missing=sorted(required - given),
                surplus=sorted(name for name in given - own if name not in kept),
                kept=kept,
            ))
    return results


def report(results, verbose=False):
    """Print one line per container, then a summary, and return the exit status."""
    for result in results:
        if result.problem:
            print(f"{result.name:<18} ?  {result.problem}")
            continue
        if result.missing:
            print(f"{result.name:<18} MISSING {len(result.missing)}: {', '.join(result.missing)}")
        if result.surplus:
            print(f"{result.name:<18} SURPLUS {len(result.surplus)}: {', '.join(result.surplus)}")
        if not result.missing and not result.surplus:
            print(f"{result.name:<18} ok ({result.required} required)")
        if verbose:
            for name, readers in result.kept.items():
                print(f"{'':<18}    kept {name}: {'; '.join(readers)}")

    unchecked = sum(1 for result in results if result.problem)
    missing = sum(1 for result in results if result.missing)
    surplus = sum(1 for result in results if result.surplus)
    print()
    if unchecked:
        print(f"{unchecked} entr{'y' if unchecked == 1 else 'ies'} could not be checked.")
    if missing:
        print(f"{missing} container(s) would fail to start. The configuration sandbox rejects a")
        print("variable a container needs and is not given.")
    if surplus:
        print(f"{surplus} container(s) receive a variable that their code does not declare and their")
        print("image does not read. The sandbox drops it, so setting it changes nothing. Remove it")
        print("from the compose file or Dockerfile that sets it. If the image does read it, under a")
        print("name this check cannot see, record the reader in check_docker_env.py.")
    if unchecked or missing or surplus:
        return 1
    print(f"All {len(results)} containers receive every variable their code requires, and every")
    print("variable they receive has a reader.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jar", help="cedar-config-library jar to interrogate")
    ap.add_argument("--verbose", action="store_true",
                    help="name what reads each undeclared variable a container keeps")
    args = ap.parse_args()

    config_jar = find_jar("cedar-config-library-*.jar", args.jar)
    if not config_jar:
        sys.exit("No cedar-config-library jar found. Build it, or pass --jar.")
    core_jar = find_jar("cedar-core-library-*.jar")
    if not core_jar:
        sys.exit("No cedar-core-library jar found. Build the libraries, or fetch it from Nexus.")

    declared = declarations(config_jar, core_jar)

    print(f"config library : {config_jar.name}")
    for stack in STACKS:
        print(f"compose file   : {stack['compose']}")
    print()
    return report(compare(declared, STACKS, BUILD), args.verbose)


if __name__ == "__main__":
    sys.exit(main())
