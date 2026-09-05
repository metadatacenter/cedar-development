#!/usr/bin/env python3
"""Check that every Docker microservice is given the environment its code requires.

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
the union of the compose environment list and the ENV lines baked into the image and its bases.

    ops/check_docker_env.py                # uses built jars or artifacts from the local Maven repo
    ops/check_docker_env.py --jar PATH     # or a config-library jar you point it at

Exits non-zero if any server is missing a variable it needs.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

CEDAR_HOME = Path(os.environ.get("CEDAR_HOME", Path.home() / "CEDAR"))
BUILD = CEDAR_HOME / "cedar-docker-build"
DEPLOY = CEDAR_HOME / "cedar-docker-deploy"

# Every stack holding containers whose configuration cedar-main.yml builds, with the compose
# service names it declares and the base images those services inherit ENV from, outermost first.
# The admin tool is here because it reads the same configuration and stops on the same absent
# variable, and it was left unchecked long enough to ship unable to start.
STACKS = [
    {
        "compose": DEPLOY / "cedar-microservices" / "docker-compose.yml",
        "service": r"server-([a-z]+)",
        "bases": ["cedar-java", "cedar-microservice"],
        "image": "cedar-server-{}",
    },
    {
        "compose": DEPLOY / "cedar-admin" / "docker-compose.yml",
        "service": r"(admin-tool)",
        "bases": ["cedar-java"],
        "image": "cedar-{}",
    },
]

DUMP = """
import org.metadatacenter.config.environment.*;
import org.metadatacenter.model.SystemComponent;
for (SystemComponent c : SystemComponent.values()) {
  var names = new java.util.TreeSet<String>();
  for (var v : CedarConfigEnvironmentDescriptor.getVariableNamesFor(c)) {
    if (!v.isOptional()) names.add(v.getName());
  }
  System.out.println("REQ\\t" + c.getStringValue() + "\\t" + String.join(",", names));
}
/exit
"""


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


def required_by_server(config_jar, core_jar):
    """Ask the code which variables each server needs."""
    java_home = os.environ.get("JAVA_HOME", "")
    jshell = Path(java_home, "bin", "jshell") if java_home else Path("jshell")
    cp = f"{config_jar}:{core_jar}"
    proc = subprocess.run([str(jshell), "--class-path", cp, "-q", "-"],
                          input=DUMP, capture_output=True, text=True)
    out = {}
    for line in proc.stdout.splitlines():
        if line.startswith("REQ\t"):
            _, server, names = line.split("\t", 2)
            out[server.lower()] = set(filter(None, names.split(",")))
    if not out:
        sys.exit(f"jshell returned no requirements.\n{proc.stdout}\n{proc.stderr}")
    return out


def env_from_dockerfile(path):
    """ENV names a Dockerfile sets, in either ENV K=V or ENV K V form."""
    if not path.exists():
        return set()
    names = set()
    for line in path.read_text().splitlines():
        m = re.match(r"\s*ENV\s+(CEDAR_[A-Z0-9_]+)[\s=]", line)
        if m:
            names.add(m.group(1))
    return names


def compose_env_by_service(compose, service_pattern):
    """The CEDAR_ variables a stack's compose file passes to each of its services."""
    if not compose.exists():
        sys.exit(f"Compose file not found: {compose}")
    text = compose.read_text()
    out = {}
    pattern = rf"^  {service_pattern}:\n((?:    .*\n|      .*\n)+)"
    for name, body in re.findall(pattern, text, re.M):
        out[name] = set(re.findall(r"- (CEDAR_[A-Z0-9_]+)$", body, re.M))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jar", help="cedar-config-library jar to interrogate")
    args = ap.parse_args()

    config_jar = find_jar("cedar-config-library-*.jar", args.jar)
    if not config_jar:
        sys.exit("No cedar-config-library jar found. Build it, or pass --jar.")
    core_jar = find_jar("cedar-core-library-*.jar")
    if not core_jar:
        sys.exit("No cedar-core-library jar found. Build the libraries, or fetch it from Nexus.")

    required = required_by_server(config_jar, core_jar)

    print(f"config library : {config_jar.name}")
    for stack in STACKS:
        print(f"compose file   : {stack['compose']}")
    print()

    failures = 0
    checked = 0
    for stack in STACKS:
        base_env = set()
        for base in stack["bases"]:
            base_env |= env_from_dockerfile(BUILD / base / "Dockerfile")
        compose = compose_env_by_service(stack["compose"], stack["service"])
        if not compose:
            print(f"{stack['compose'].parent.name:<18} ?  declares no services to check")
            failures += 1
            continue
        for service in sorted(compose):
            checked += 1
            need = required.get(service)
            if need is None:
                print(f"{service:<18} ?  no SystemComponent named this container")
                failures += 1
                continue
            image = BUILD / stack["image"].format(service) / "Dockerfile"
            given = compose[service] | base_env | env_from_dockerfile(image)
            missing = sorted(need - given)
            if missing:
                failures += 1
                print(f"{service:<18} MISSING {len(missing)}: {', '.join(missing)}")
            else:
                print(f"{service:<18} ok ({len(need)} required)")

    print()
    if failures:
        print(f"{failures} container(s) would fail to start: the configuration sandbox rejects a")
        print("variable the container needs and is not given.")
        return 1
    print(f"All {checked} containers are given every variable their code declares they need.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
