#!/bin/bash

# Publish an immutable npm prerelease for a CEDAR frontend without changing its working tree.
# npm versions cannot be overwritten like Maven SNAPSHOTs, so the package version is derived from
# the application version, commit timestamp, and commit ID. Re-running this for the same commit is
# idempotent: an existing artifact is accepted only when it records the same full gitHead.

set -euo pipefail

: "${CEDAR_HOME:?CEDAR_HOME must point to the CEDAR checkout root}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "${1:-}" in
  main)
    repo_name=cedar-template-editor
    package_path=.
    ;;
  workspace)
    repo_name=cedar-workspace
    package_path=.
    ;;
  designer)
    repo_name=cedar-template-designer
    package_path=.
    ;;
  openview)
    repo_name=cedar-openview
    package_path=cedar-openview-dist
    ;;
  content)
    repo_name=cedar-content-distribution
    package_path=.
    ;;
  monitoring)
    repo_name=cedar-monitoring
    package_path=cedar-monitoring-dist
    ;;
  bridging)
    repo_name=cedar-bridging
    package_path=cedar-bridging-dist
    ;;
  *)
    echo "Usage: $0 main|workspace|designer|openview|content|monitoring|bridging [--dry-run]" >&2
    exit 2
    ;;
esac

dry_run=false
if [ "${2:-}" = "--dry-run" ]; then
  dry_run=true
elif [ -n "${2:-}" ]; then
  echo "Usage: $0 main|workspace|designer|openview|content|monitoring|bridging [--dry-run]" >&2
  exit 2
fi

repo_dir="${CEDAR_HOME}/${repo_name}"
package_dir="${repo_dir}/${package_path}"
if [ ! -d "${repo_dir}/.git" ] || [ ! -f "${package_dir}/package.json" ]; then
  echo "Missing frontend package: ${package_dir}" >&2
  exit 1
fi
train_package_version=${CEDAR_TRAIN_PACKAGE_VERSION:-}
if [ -z "${train_package_version}" ] && \
   [ -n "$(git -C "${repo_dir}" status --porcelain --untracked-files=normal)" ]; then
  echo "Refusing to publish a dirty frontend repository: ${repo_name}" >&2
  exit 1
fi

source_commit=$(git -C "${repo_dir}" rev-parse --verify HEAD)
commit_timestamp=$(TZ=UTC git -C "${repo_dir}" show -s --format=%cd --date=format:%Y%m%d%H%M%S HEAD)
short_commit="g${source_commit:0:12}"
package_name=$(node -p "require('${package_dir}/package.json').name")
manifest_version=$(node -p "require('${package_dir}/package.json').version")
registry=$(node -p "require('${package_dir}/package.json').publishConfig.registry")

if [[ "${manifest_version}" == *-SNAPSHOT ]]; then
  version_base=${manifest_version%-SNAPSHOT}
else
  version_base=${manifest_version%%-*}
fi
if [ -n "${train_package_version}" ]; then
  package_version=${train_package_version}
else
  package_version="${version_base}-dev.${commit_timestamp}.${short_commit}.p3"
fi

if existing_commit=$(npm view "${package_name}@${package_version}" gitHead \
  --registry "${registry}" --json 2>/dev/null); then
  existing_commit=$(printf '%s' "${existing_commit}" | tr -d '"[:space:]')
else
  existing_commit=
fi
if [ -n "${existing_commit}" ]; then
  if [ "${existing_commit}" != "${source_commit}" ]; then
    echo "${package_name}@${package_version} exists with a different gitHead" >&2
    exit 1
  fi
  echo "Already published ${package_name}@${package_version} (${source_commit})"
  echo "CEDAR_PUBLISHED_NPM_VERSION=${package_version}"
  exit 0
fi

staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/cedar-npm-publish.XXXXXX")
cleanup() {
  status=$?
  rm -rf "${staging_dir}"
  exit ${status}
}
trap cleanup EXIT

source_dir="${staging_dir}/source"
mkdir -p "${source_dir}"
# The package identity names a Git commit, so its bytes must come from that commit as well. Packing
# the working tree would allow ignored build output to enter an otherwise clean repository.
git -C "${repo_dir}" archive --format=tar HEAD | tar -xf - -C "${source_dir}"
if [ -n "${train_package_version}" ] && [ -n "${CEDAR_TRAIN_OVERLAY_PATHS:-}" ]; then
  IFS=: read -r -a overlay_paths <<< "${CEDAR_TRAIN_OVERLAY_PATHS}"
  for relative in "${overlay_paths[@]}"; do
    if [ -z "${relative}" ] || [ "${relative}" = "." ] || \
       [[ "${relative}" = /* ]] || [[ "/${relative}/" = *"/../"* ]]; then
      echo "Invalid prepared frontend overlay path: ${relative}" >&2
      exit 1
    fi
    overlay_source="${repo_dir}/${relative}"
    overlay_target="${source_dir}/${relative}"
    if [ ! -e "${overlay_source}" ]; then
      echo "Missing prepared frontend overlay: ${overlay_source}" >&2
      exit 1
    fi
    rm -rf "${overlay_target}"
    mkdir -p "$(dirname "${overlay_target}")"
    cp -a "${overlay_source}" "${overlay_target}"
  done
fi
archived_package_dir="${source_dir}/${package_path}"
if [ ! -f "${archived_package_dir}/package.json" ] || \
   [ ! -f "${archived_package_dir}/package-lock.json" ]; then
  echo "Committed frontend package metadata is missing from ${repo_name}:${package_path}" >&2
  exit 1
fi

npm pack "${archived_package_dir}" --pack-destination "${staging_dir}" --loglevel=error >/dev/null
package_tarball=("${staging_dir}"/*.tgz)
if [ ! -f "${package_tarball[0]}" ]; then
  echo "npm pack did not produce a tarball for ${package_name}" >&2
  exit 1
fi

tar -xzf "${package_tarball[0]}" -C "${staging_dir}"
npm pkg set \
  "version=${package_version}" \
  "gitHead=${source_commit}" \
  --prefix "${staging_dir}/package"
node "${SCRIPT_DIR}/stage-npm-shrinkwrap.mjs" \
  "${archived_package_dir}/package-lock.json" \
  "${staging_dir}/package/npm-shrinkwrap.json" \
  "${package_name}" \
  "${package_version}"

staged_name=$(node -p "require('${staging_dir}/package/package.json').name")
staged_version=$(node -p "require('${staging_dir}/package/package.json').version")
staged_commit=$(node -p "require('${staging_dir}/package/package.json').gitHead")
if [ "${staged_name}" != "${package_name}" ] || [ "${staged_version}" != "${package_version}" ] || \
   [ "${staged_commit}" != "${source_commit}" ] || \
   [ ! -f "${staging_dir}/package/npm-shrinkwrap.json" ]; then
  echo "Staged npm package identity does not match its source" >&2
  exit 1
fi

if [ "${dry_run}" = true ]; then
  npm publish "${staging_dir}/package" --tag dev --registry "${registry}" --loglevel=error --dry-run
  echo "Dry-run package ${package_name}@${package_version} (${source_commit})"
else
  npm publish "${staging_dir}/package" --tag dev --registry "${registry}" --loglevel=error
  echo "Published ${package_name}@${package_version} (${source_commit})"
fi
echo "CEDAR_PUBLISHED_NPM_VERSION=${package_version}"
