#!/usr/bin/env bash
# Reproduce the audit in temporary source copies, leaving the working checkouts untouched.
# Requires the existing CEDAR Maven dependencies and embedded database binaries in local caches.
# Known bugs intentionally fail six assertions across eight cases; any error needs investigation.
set -eo pipefail
: "${CEDAR_HOME:?Export CEDAR_HOME to the CEDAR installation directory}"
export CEDAR_HOME
export CEDAR_PROFILE=develop
source "$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
set -u
if [ -x /usr/libexec/java_home ]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
fi
audit_bundle="$(cd "$(dirname "$0")" && pwd)"
audit_scratch="$(mktemp -d "${TMPDIR:-/tmp}/cedar-backend-sequences.XXXXXX")"
echo "Audit scratch and logs: $audit_scratch"
audit_failed=0
for audit_repo in cedar-worker-server cedar-artifact-server cedar-resource-server; do
  mkdir -p "$audit_scratch/$audit_repo"
  rsync -a --exclude=.git --exclude=target "$CEDAR_HOME/$audit_repo/" "$audit_scratch/$audit_repo/"
  cp -R "$audit_bundle/tests/$audit_repo/." "$audit_scratch/$audit_repo/"
  case "$audit_repo" in
    cedar-worker-server) audit_module=cedar-worker-server-core; audit_test=CloneAcknowledgementAuditTest ;;
    cedar-artifact-server) audit_module=cedar-artifact-server-application; audit_test=ArtifactRecreationAuditTest ;;
    cedar-resource-server) audit_module=cedar-resource-server-application; audit_test=CrossStoreSequenceAuditTest ;;
  esac
  if (cd "$audit_scratch/$audit_repo" && ./mvnw -o -pl "$audit_module" -am \
      -Dtest="$audit_test" -Dsurefire.failIfNoSpecifiedTests=false test) > "$audit_scratch/$audit_repo.log" 2>&1; then
    echo "$audit_test: passed"
  else
    audit_failed=1
    echo "$audit_test: failed; see $audit_scratch/$audit_repo.log"
  fi
done
exit "$audit_failed"
