#!/usr/bin/env bash
# Canonical CEDAR artifact validation gate.
#
#   instance <template.json> <instance.jsonld>   Validate an instance against its template
#   template <template.json>                     Validate a template
#   element  <element.json>                      Validate a template element
#   field    <field.json>                        Validate a template field
#
# This is `cedar-model-validation-library` — the arbiter. Nothing enters production
# that this rejects, so it is the check that matters and every other conformance
# number is an approximation of it.
#
# The library already ships runnable entry points under
# `org.metadatacenter.model.validation.exec`, so nothing here adds Java; it only
# resolves JDK 17, caches the dependency classpath, and dispatches. The
# `scripts/validate-*.sh` wrappers inside the library do NOT work — they call
# `python` rather than `python3`, want an uninstalled `jsonschema` module, and
# point at a generated-but-uncommitted `template-schema.json`. Use this instead.
#
# Exit status is the point: 0 valid, 1 invalid, 2 could not run. The library's
# mains always exit 0 and say "Instance is invalid" on stdout, which is useless in
# a pipeline, so the verdict is re-derived from the output here.
#
# Requires JDK 17 (the POM enforces `[17,18)` and refuses 21 or 23) and a built
# library — `mvn install` `cedar-parent` first if you have not, since it resolves
# only against the CEDAR nexus and the public repos return 402 for it.
set -euo pipefail

CMD=${1:-}
LIB=${CEDAR_VALIDATION_LIB:-${CEDAR_HOME:+$CEDAR_HOME/cedar-model-validation-library}}
# Fall back to the sibling checkout, which is the usual layout.
if [[ -z ${LIB:-} || ! -d $LIB ]]; then
  LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/cedar-model-validation-library"
fi
[[ -d $LIB ]] || { echo "cedar-model-validation-library not found (set CEDAR_VALIDATION_LIB)" >&2; exit 2; }

# java_home resolves a JDK on macOS and does not exist elsewhere, so fall back to the location the
# rest of the tooling searches, and give advice the host in hand can actually follow.
JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}
if [[ ! -x ${JAVA_HOME:-}/bin/java ]]; then
  for candidate in /usr/lib/jvm/java-17-*; do
    [[ -x $candidate/bin/java ]] && { JAVA_HOME=$candidate; break; }
  done
fi
if [[ ! -x ${JAVA_HOME:-}/bin/java ]]; then
  if [[ -x /usr/libexec/java_home ]]; then
    echo "JDK 17 not found: export JAVA_HOME=\$(/usr/libexec/java_home -v 17)" >&2
  else
    echo "JDK 17 not found: export JAVA_HOME to a JDK 17, usually one of /usr/lib/jvm/java-17-*" >&2
  fi
  exit 2
fi

CP_FILE="$LIB/target/validator-classpath.txt"
CLASSES="$LIB/target/classes"

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# Build the classpath once and reuse it. Rebuilt when the POM is newer, which is
# the only thing that changes it.
ensure_classpath() {
  if [[ ! -d $CLASSES ]]; then
    echo "building $LIB ..." >&2
    (cd "$LIB" && JAVA_HOME="$JAVA_HOME" mvn -q -DskipTests compile) || exit 2
  fi
  if [[ ! -f $CP_FILE || $LIB/pom.xml -nt $CP_FILE ]]; then
    echo "resolving dependency classpath ..." >&2
    (cd "$LIB" && JAVA_HOME="$JAVA_HOME" mvn -q dependency:build-classpath \
      -Dmdep.outputFile="$CP_FILE") || exit 2
  fi
}

run() {
  local main=$1; shift
  for f in "$@"; do
    [[ -f $f ]] || { echo "no such file: $f" >&2; exit 2; }
  done
  ensure_classpath
  local out
  out=$("$JAVA_HOME/bin/java" -cp "$CLASSES:$(cat "$CP_FILE")" \
    "org.metadatacenter.model.validation.exec.$main" "$@" 2>&1 | grep -v '^SLF4J' || true)
  echo "$out"
  # The mains print "... is valid" or "... is invalid. Found N error(s)" and exit
  # 0 either way, so the status has to come from the text.
  if grep -qi 'is valid' <<<"$out"; then return 0; fi
  if grep -qi 'is invalid' <<<"$out"; then return 1; fi
  echo "could not interpret validator output" >&2
  return 2
}

case $CMD in
  instance) [[ $# -eq 3 ]] || usage; run ValidateTemplateInstance "$2" "$3" ;;
  template) [[ $# -eq 2 ]] || usage; run ValidateTemplate "$2" ;;
  element)  [[ $# -eq 2 ]] || usage; run ValidateTemplateElement "$2" ;;
  field)    [[ $# -eq 2 ]] || usage; run ValidateTemplateField "$2" ;;
  *) usage ;;
esac
