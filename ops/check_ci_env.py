#!/usr/bin/env python3
"""Check that every Java repository's CI gives its tests the environment the code requires.

A CEDAR server declares what it needs in code. CedarConfigEnvironmentDescriptor maps each
SystemComponent to a set of CedarEnvironmentVariable, CedarEnvironmentVariableProvider builds the
configuration sandbox from it, and a variable a component needs but does not get stops it dead —
which in a test run means the whole suite fails at the first CedarConfig.getInstance.

Every Java repository's ci.yml therefore carries the same block of CEDAR_ entries, and until this
existed each carried its own copy: twenty-two hand-maintained restatements of one declaration, with
nothing comparing them to it or to each other. They had already diverged. cedar-monitor-server's
block held 55 of the 118 entries, missing CEDAR_SALT_API_KEY, CEDAR_TRUSTED_FOLDERS and the two
test-user identifiers among sixty-three others.

This is the same instinct as check_docker_env.py, pointed at the other set of copies: ask the code
what it needs rather than reading the declaration by eye, and keep one block rather than
twenty-two. ops/ci-env-block.yml is that block; each repository's ci.yml holds a copy of it, and
this reports — or repairs — any copy that has drifted.

    ops/check_ci_env.py                # report
    ops/check_ci_env.py --apply        # report, then rewrite the drifted copies
    ops/check_ci_env.py --jar PATH     # against a config-library jar you point it at

Exits non-zero if any copy has drifted, or if the canonical block no longer satisfies the code.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

CEDAR_HOME = Path(os.environ.get("CEDAR_HOME", Path.home() / "CEDAR"))
CANONICAL = Path(__file__).resolve().parent / "ci-env-block.yml"

# The variables the servers declare, and which of those the provider will default rather than
# demand. A boolean it does not receive becomes "false"; anything else it does not receive is fatal,
# so the block must carry it.
DUMP = """
import org.metadatacenter.config.environment.*;
import org.metadatacenter.model.SystemComponent;
var declared = new java.util.TreeSet<String>();
var optional = new java.util.TreeSet<String>();
for (SystemComponent c : SystemComponent.values()) {
  if (c.getServerName() == null) continue;
  for (var v : CedarConfigEnvironmentDescriptor.getVariableNamesFor(c)) {
    declared.add(v.getName());
    if (v.isBoolean()) optional.add(v.getName());
  }
}
System.out.println("DECLARED\\t" + String.join(",", declared));
System.out.println("OPTIONAL\\t" + String.join(",", optional));
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


def declared_by_servers(config_jar, core_jar):
    """Ask the code which variables the servers need, and which of those it will default."""
    java_home = os.environ.get("JAVA_HOME", "")
    jshell = Path(java_home, "bin", "jshell") if java_home else Path("jshell")
    proc = subprocess.run([str(jshell), "--class-path", f"{config_jar}:{core_jar}", "-q", "-"],
                          input=DUMP, capture_output=True, text=True)
    declared, optional = set(), set()
    for line in proc.stdout.splitlines():
        if line.startswith("DECLARED\t"):
            declared = set(filter(None, line.split("\t", 1)[1].split(",")))
        elif line.startswith("OPTIONAL\t"):
            optional = set(filter(None, line.split("\t", 1)[1].split(",")))
    if not declared:
        sys.exit(f"jshell returned no requirements.\n{proc.stdout}\n{proc.stderr}")
    return declared, optional


def block_region(text):
    """The CEDAR_ block inside a workflow's env: mapping, as (first, last) line indices.

    The region runs from the first CEDAR_ entry to the last, so the comments sitting between them
    travel with it. Entries that are not CEDAR_ ones — the Nexus credentials — sit above it and are
    left alone.
    """
    lines = text.splitlines()
    hits = [i for i, line in enumerate(lines) if line.startswith("      CEDAR_")]
    if not hits:
        return None
    return hits[0], hits[-1]


def names_in(block):
    return {m.group(1) for m in re.finditer(r"^      (CEDAR_[A-Z0-9_]+):", block, re.MULTILINE)}


def workflows():
    for repo in sorted(CEDAR_HOME.glob("cedar-*")):
        path = repo / ".github" / "workflows" / "ci.yml"
        if path.is_file() and "      CEDAR_" in path.read_text(encoding="utf-8"):
            yield repo.name, path


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="rewrite the copies that have drifted")
    parser.add_argument("--jar", help="config-library jar to ask")
    parser.add_argument("--core-jar", help="core-library jar for the SystemComponent enum")
    args = parser.parse_args()

    canonical = CANONICAL.read_text(encoding="utf-8").rstrip("\n")
    canonical_names = names_in(canonical)

    config_jar = find_jar("cedar-config-library-*.jar", args.jar)
    core_jar = find_jar("cedar-core-library-*.jar", args.core_jar)
    if not config_jar or not core_jar:
        sys.exit("Could not find the config and core library jars. Build them, or pass --jar/--core-jar.")

    declared, optional = declared_by_servers(config_jar, core_jar)
    required = declared - optional

    failures = 0

    missing = sorted(required - canonical_names)
    if missing:
        failures += 1
        print(f"{CANONICAL.name} is missing {len(missing)} variable(s) the servers require:")
        for name in missing:
            print(f"    {name}")

    unknown = sorted(canonical_names - declared)
    if unknown:
        failures += 1
        print(f"{CANONICAL.name} sets {len(unknown)} variable(s) no server declares:")
        for name in unknown:
            print(f"    {name}")

    if not missing and not unknown:
        print(f"{CANONICAL.name}: {len(canonical_names)} entries, and the code asks for nothing it lacks")

    drifted = []
    for name, path in workflows():
        text = path.read_text(encoding="utf-8")
        first, last = block_region(text)
        lines = text.splitlines()
        current = "\n".join(lines[first:last + 1])
        if current == canonical:
            print(f"  OK      {name}")
            continue
        drifted.append((name, path, first, last))
        present = names_in(current)
        print(f"  DRIFTED {name}: {len(present)} entries, "
              f"{len(canonical_names - present)} missing, {len(present - canonical_names)} extra")

    if drifted and args.apply:
        for name, path, first, last in drifted:
            lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
            replacement = [line + "\n" for line in canonical.split("\n")]
            path.write_text("".join(lines[:first] + replacement + lines[last + 1:]), encoding="utf-8")
            print(f"  REWROTE {name}")
    elif drifted:
        failures += 1
        print(f"\n{len(drifted)} copy(ies) have drifted from {CANONICAL.name}. "
              f"Re-run with --apply to rewrite them.")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
