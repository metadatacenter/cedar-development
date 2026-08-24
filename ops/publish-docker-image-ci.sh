#!/usr/bin/env bash

set -euo pipefail

image=${1:?usage: publish-docker-image-ci.sh IMAGE}
: "${TRAIN_VERSION:?TRAIN_VERSION is required}"
: "${BMIR_NEXUS_USERNAME:?BMIR_NEXUS_USERNAME is required}"
: "${BMIR_NEXUS_PASSWORD:?BMIR_NEXUS_PASSWORD is required}"
: "${CEDAR_DOCKER_REGISTRY_HOST:?CEDAR_DOCKER_REGISTRY_HOST is required}"

controller=${GITHUB_WORKSPACE}/controller
workspace=${RUNNER_TEMP}/CEDAR
state=${RUNNER_TEMP}/build-trains

git clone --quiet --depth 1 --branch build-trains \
  "https://github.com/${GITHUB_REPOSITORY}.git" "${state}"
python3 "${controller}/ops/docker_train.py" checkout \
  --version "${TRAIN_VERSION}" \
  --workspace "${workspace}" \
  --state "${state}"
python3 -m pip install --quiet --disable-pip-version-check \
  -r "${workspace}/cedar-cli/requirements.txt"

trap 'docker logout "${CEDAR_DOCKER_REGISTRY_HOST}" >/dev/null 2>&1 || true' EXIT
printf '%s' "${BMIR_NEXUS_PASSWORD}" | docker login "${CEDAR_DOCKER_REGISTRY_HOST}" \
  --username "${BMIR_NEXUS_USERNAME}" --password-stdin

python3 "${controller}/ops/docker_train.py" publish-image \
  --version "${TRAIN_VERSION}" \
  --image "${image}" \
  --workspace "${workspace}"
