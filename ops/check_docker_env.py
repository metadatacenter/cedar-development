#!/usr/bin/env python3
"""Check that every Docker microservice is given the environment its code requires.

A CEDAR server declares what it needs in code. CedarConfigEnvironmentDescriptor maps each
SystemComponent to a set of CedarEnvironmentVariable, and CedarEnvironmentVariableProvider builds
the configuration sandbox from it: a variable the server needs but does not get is fatal at
startup, while one it does not need is defaulted (0 for numerics, false for booleans) or held back.
That asymmetry is why most absent variables are harmless and a few stop the server dead.

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
COMPOSE = CEDAR_HOME / "cedar-docker-deploy" / "cedar-microservices" / "docker-compose.yml"

# Bases every server image inherits ENV from, outermost first.
BASE_IMAGES = ["cedar-java", "cedar-microservice"]

DUMP = """
import org.metadatacenter.config.environment.*;
import org.metadatacenter.model.SystemComponent;
for (SystemComponent c : SystemComponent.values()) {
  if (c.getServerName() == null) continue;
  var names = new java.util.TreeSet<String>();
  for (var v : CedarConfigEnvironmentDescriptor.getVariableNamesFor(c)) names.add(v.getName());
  System.out.println("REQ\\t" + c.getServerName() + "\\t" + String.join(",", names));
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


def compose_env_by_service():
    text = COMPOSE.read_text()
    out = {}
    for name, body in re.findall(r"^  server-([a-z]+):\n((?:    .*\n|      .*\n)+)", text, re.M):
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
    compose = compose_env_by_service()
    base_env = set()
    for base in BASE_IMAGES:
        base_env |= env_from_dockerfile(BUILD / base / "Dockerfile")

    print(f"config library : {config_jar.name}")
    print(f"compose file   : {COMPOSE}")
    print()

    failures = 0
    for server in sorted(compose):
        need = required.get(server)
        if need is None:
            print(f"{server:<18} ?  no SystemComponent named this server")
            failures += 1
            continue
        given = compose[server] | base_env | env_from_dockerfile(BUILD / f"cedar-server-{server}" / "Dockerfile")
        missing = sorted(need - given)
        if missing:
            failures += 1
            print(f"{server:<18} MISSING {len(missing)}: {', '.join(missing)}")
        else:
            print(f"{server:<18} ok ({len(need)} required)")

    print()
    if failures:
        print(f"{failures} server(s) would fail to start: the configuration sandbox rejects a")
        print("variable the server needs and the container is not given.")
        return 1
    print("Every server is given every variable its code declares it needs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
