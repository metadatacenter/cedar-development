#!/usr/bin/env python3
"""Publish and verify a complete immutable CEDAR Docker image train."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "docker-train.json"
STATE_BASE_URL = "https://raw.githubusercontent.com/metadatacenter/cedar-development/build-trains"
TRAIN_RE = re.compile(r"^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MANIFEST_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
CHECKOUT_REPOSITORIES = ("cedar-cli", "cedar-docker-build")
FRONTEND_IMAGES = (
    "cedar-frontend-main",
    "cedar-frontend-workspace",
    "cedar-frontend-template-designer",
    "cedar-frontend-openview",
    "cedar-frontend-content",
    "cedar-frontend-monitoring",
    "cedar-frontend-bridging",
)


def run(arguments: list[str], cwd: Path | None = None, capture: bool = False,
        check: bool = True, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    print("+", " ".join(arguments), f"(in {cwd})" if cwd else "", flush=True)
    result = subprocess.run(
        arguments,
        cwd=cwd,
        text=True,
        capture_output=capture,
        check=False,
        env=environment,
    )
    if check and result.returncode:
        if capture:
            sys.stderr.write(result.stderr)
        raise RuntimeError(f"command failed with exit code {result.returncode}: {' '.join(arguments)}")
    return result


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def fetch_json(relative_path: str) -> dict:
    url = f"{STATE_BASE_URL}/{relative_path}"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise RuntimeError(f"build-train state does not exist: {relative_path}") from error
        raise


def validate_train(version: str) -> str:
    if not TRAIN_RE.fullmatch(version):
        raise ValueError(f"invalid train {version!r}; expected 2.9.3-dev.YYYYMMDD.HHMM")
    return version


def train_key(version: str) -> tuple[int, int, int, str, str]:
    validate_train(version)
    base, timestamp = version.split("-dev.", 1)
    major, minor, patch = (int(part) for part in base.split("."))
    day, minute = timestamp.split(".", 1)
    return major, minor, patch, day, minute


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def source_manifest(version: str, state: Path | None = None) -> tuple[dict, bytes]:
    relative = f"trains/{validate_train(version)}.json"
    if state is None:
        payload = fetch_json(relative)
        content = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode()
        return payload, content
    path = state / relative
    if not path.exists():
        raise RuntimeError(f"Java train {version} has no source manifest")
    content = path.read_bytes()
    return json.loads(content), content


def require_maven_completion(version: str, state: Path | None = None) -> dict:
    relative = f"completed/{validate_train(version)}.json"
    payload = fetch_json(relative) if state is None else load_json(state / relative)
    if payload.get("version") != version:
        raise RuntimeError(f"Maven completion record does not describe {version}")
    return payload


def require_npm_completion(version: str, state: Path | None = None) -> dict:
    relative = f"npm/completed/{validate_train(version)}.json"
    payload = fetch_json(relative) if state is None else load_json(state / relative)
    if payload.get("version") != version:
        raise RuntimeError(f"npm completion record does not describe {version}")
    plan_hash = payload.get("planSha256", "")
    if not MANIFEST_SHA_RE.fullmatch(plan_hash):
        raise RuntimeError(f"npm completion record for {version} has no valid plan digest")
    return payload


def runtime_manifest(version: str, source_hash: str, npm_completion: dict) -> dict:
    return {
        "schemaVersion": 1,
        "train": version,
        "sourceManifestSha256": source_hash,
        "npmPlanSha256": npm_completion["planSha256"],
        "dockerInputs": npm_completion["dockerInputs"],
        "packages": npm_completion["packages"],
    }


def core_images(config: dict) -> list[str]:
    ordered = []
    for group in ("javaBase", "microserviceBase", "infrastructure", "microservices", "frontends"):
        for image in config["groups"][group]:
            if image in ordered:
                raise RuntimeError(f"Docker train configuration repeats {image}")
            ordered.append(image)
    if len(ordered) != 31:
        raise RuntimeError(f"Docker train must contain 31 core images, found {len(ordered)}")
    return ordered


def prefix_for(config: dict, image: str) -> str:
    internal = set(config["groups"]["javaBase"] + config["groups"]["microserviceBase"])
    return config["internalPrefix"] if image in internal else config["publicPrefix"]


def reference_for(config: dict, image: str, version: str) -> str:
    return f"{prefix_for(config, image)}/{image}:{version}"


def manifest_sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def matrix(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    if args.group not in config["groups"]:
        raise RuntimeError(f"unknown Docker train group {args.group}")
    print(json.dumps(config["groups"][args.group], separators=(",", ":")))


def record_plan(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    version = validate_train(args.version)
    source, content = source_manifest(version, args.state)
    require_maven_completion(version, args.state)
    npm = require_npm_completion(version, args.state)
    if npm.get("sourceManifestSha256") != manifest_sha(content):
        raise RuntimeError("npm completion was verified against a different source manifest")
    repositories = source.get("repositories", {})
    for repository in CHECKOUT_REPOSITORIES:
        if not SHA_RE.fullmatch(repositories.get(repository, "")):
            raise RuntimeError(f"Java train manifest has no valid commit for {repository}")
    images = [
        {
            "image": image,
            "prefix": prefix_for(config, image),
            "reference": reference_for(config, image, version),
        }
        for image in core_images(config)
    ]
    plan = {
        "schemaVersion": 2,
        "version": version,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "javaManifest": f"trains/{version}.json",
        "javaCompletion": f"completed/{version}.json",
        "npmPlan": f"npm/trains/{version}.json",
        "npmCompletion": f"npm/completed/{version}.json",
        "npmPlanSha256": npm["planSha256"],
        "sourceManifestSha256": manifest_sha(content),
        "repositories": {name: repositories[name] for name in CHECKOUT_REPOSITORIES},
        "frontendPackages": npm["dockerInputs"],
        "images": images,
    }
    destination = args.state / "docker" / "trains" / f"{version}.json"
    if destination.exists():
        existing = load_json(destination)
        comparable = dict(existing)
        comparable.pop("createdAt", None)
        proposed = dict(plan)
        proposed.pop("createdAt", None)
        if comparable != proposed:
            raise RuntimeError(f"recorded Docker plan for {version} differs from this source manifest")
        print(f"Docker plan for {version} is already recorded.")
        return
    write_json(destination, plan)
    print(f"Recorded Docker plan for {len(images)} core images at {version}.")


def checkout_one(repository: str, revision: str, workspace: Path) -> None:
    target = workspace / repository
    if target.exists():
        raise RuntimeError(f"checkout target already exists: {target}")
    target.mkdir(parents=True)
    run(["git", "init", "--quiet"], cwd=target)
    run(["git", "remote", "add", "origin", f"https://github.com/metadatacenter/{repository}.git"], cwd=target)
    run(["git", "fetch", "--quiet", "--depth", "1", "origin", revision], cwd=target)
    run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd=target)


def checkout(args: argparse.Namespace) -> None:
    version = validate_train(args.version)
    source, content = source_manifest(version, args.state)
    require_maven_completion(version, args.state)
    npm = require_npm_completion(version, args.state)
    if npm.get("sourceManifestSha256") != manifest_sha(content):
        raise RuntimeError("npm completion was verified against a different source manifest")
    args.workspace.mkdir(parents=True, exist_ok=True)
    if any(args.workspace.iterdir()):
        raise RuntimeError(f"Docker workspace is not empty: {args.workspace}")
    for repository in CHECKOUT_REPOSITORIES:
        revision = source.get("repositories", {}).get(repository, "")
        if not SHA_RE.fullmatch(revision):
            raise RuntimeError(f"Java train manifest has no valid commit for {repository}")
        checkout_one(repository, revision, args.workspace)
    (args.workspace / ".cedar-train-manifest-sha256").write_text(
        manifest_sha(content) + "\n", encoding="utf-8"
    )
    embedded = runtime_manifest(version, manifest_sha(content), npm)
    embedded_content = (json.dumps(embedded, indent=2, sort_keys=True) + "\n").encode()
    embedded_hash = manifest_sha(embedded_content)
    (args.workspace / ".cedar-frontend-manifest-sha256").write_text(
        embedded_hash + "\n", encoding="utf-8"
    )
    (args.workspace / ".cedar-frontend-inputs.json").write_text(
        json.dumps(npm["dockerInputs"], sort_keys=True) + "\n", encoding="utf-8"
    )
    docker_build = args.workspace / "cedar-docker-build"
    for image in FRONTEND_IMAGES:
        (docker_build / image / "cedar-build-manifest.json").write_bytes(embedded_content)
    print(f"Checked out Docker builder inputs for {version}.")


def expected_labels(image: str, version: str, source_hash: str,
                    frontend_hash: str) -> dict[str, str]:
    if not MANIFEST_SHA_RE.fullmatch(source_hash):
        raise RuntimeError("source manifest digest is not a lowercase SHA-256")
    if not MANIFEST_SHA_RE.fullmatch(frontend_hash):
        raise RuntimeError("frontend manifest digest is not a lowercase SHA-256")
    return {
        "org.metadatacenter.cedar.image": image,
        "org.metadatacenter.cedar.train": version,
        "org.metadatacenter.cedar.source-manifest-sha256": source_hash,
        "org.metadatacenter.cedar.frontend-manifest-sha256": frontend_hash,
    }


def inspect_image(reference: str) -> dict:
    result = run(["docker", "image", "inspect", reference], capture=True)
    payload = json.loads(result.stdout)
    if len(payload) != 1:
        raise RuntimeError(f"Docker returned an unexpected inspection result for {reference}")
    return payload[0]


def verify_labels(reference: str, inspected: dict, expected: dict[str, str]) -> None:
    labels = inspected.get("Config", {}).get("Labels") or {}
    wrong = [name for name, value in expected.items() if labels.get(name) != value]
    if wrong:
        raise RuntimeError(f"{reference} has incorrect provenance labels: {', '.join(wrong)}")


def verify_embedded_manifest(image: str, reference: str, expected_hash: str) -> None:
    if image not in FRONTEND_IMAGES:
        return
    result = run([
        "docker", "run", "--rm", "--entrypoint", "sha256sum", reference,
        "/usr/local/share/cedar-build-manifest.json",
    ], capture=True)
    actual = result.stdout.split()[0] if result.stdout.split() else ""
    if actual != expected_hash:
        raise RuntimeError(f"{reference} contains the wrong cedar-build-manifest.json")


def remote_exists(reference: str) -> bool:
    result = run(["docker", "manifest", "inspect", reference], capture=True, check=False)
    return result.returncode == 0


def publish_image(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    version = validate_train(args.version)
    images = core_images(config)
    if args.image not in images:
        raise RuntimeError(f"{args.image} is not one of the 31 core images")
    source_hash_path = args.workspace / ".cedar-train-manifest-sha256"
    if not source_hash_path.exists():
        raise RuntimeError("Docker workspace has no source-manifest digest; run checkout first")
    source_hash = source_hash_path.read_text(encoding="utf-8").strip()
    frontend_hash_path = args.workspace / ".cedar-frontend-manifest-sha256"
    if not frontend_hash_path.exists():
        raise RuntimeError("Docker workspace has no frontend-manifest digest; run checkout first")
    frontend_hash = frontend_hash_path.read_text(encoding="utf-8").strip()
    expected = expected_labels(args.image, version, source_hash, frontend_hash)
    reference = reference_for(config, args.image, version)

    if remote_exists(reference):
        run(["docker", "pull", reference])
        verify_labels(reference, inspect_image(reference), expected)
        verify_embedded_manifest(args.image, reference, frontend_hash)
        print(f"Verified already-published image {reference}.")
        return

    environment = os.environ.copy()
    environment.update({
        "CEDAR_HOME": str(args.workspace),
        "CEDAR_IMAGE_PREFIX": config["publicPrefix"],
        "CEDAR_BASE_IMAGE_PREFIX": config["internalPrefix"],
        "CEDAR_TRAIN_MANIFEST_SHA256": source_hash,
        "CEDAR_FRONTEND_MANIFEST_SHA256": frontend_hash,
    })
    inputs = load_json(args.workspace / ".cedar-frontend-inputs.json")
    environment.update({name: str(value) for name, value in inputs.items()})
    cli = args.workspace / "cedar-cli" / "cedar.py"
    run([
        sys.executable,
        str(cli),
        "docker",
        "build",
        args.image,
        "--no-deps",
        "--train",
        version,
    ], environment=environment)
    verify_labels(reference, inspect_image(reference), expected)
    verify_embedded_manifest(args.image, reference, frontend_hash)
    run(["docker", "push", reference])
    run(["docker", "pull", reference])
    verify_labels(reference, inspect_image(reference), expected)
    verify_embedded_manifest(args.image, reference, frontend_hash)
    print(f"Published and verified {reference}.")


def repository_digest(reference: str, inspected: dict) -> str:
    repository = reference.rsplit(":", 1)[0]
    matches = [value for value in inspected.get("RepoDigests", []) if value.startswith(repository + "@")]
    if len(matches) != 1:
        raise RuntimeError(f"{reference} has no unique repository digest")
    digest = matches[0].split("@", 1)[1]
    if not DIGEST_RE.fullmatch(digest):
        raise RuntimeError(f"{reference} returned an invalid registry digest {digest}")
    return digest


def verify(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    version = validate_train(args.version)
    plan_path = args.state / "docker" / "trains" / f"{version}.json"
    if not plan_path.exists():
        raise RuntimeError(f"Docker train {version} has no recorded plan")
    plan = load_json(plan_path)
    source_hash = plan.get("sourceManifestSha256", "")
    npm = require_npm_completion(version, args.state)
    if npm.get("sourceManifestSha256") != source_hash:
        raise RuntimeError("npm completion was verified against a different source manifest")
    embedded = runtime_manifest(version, source_hash, npm)
    frontend_hash = manifest_sha((json.dumps(embedded, indent=2, sort_keys=True) + "\n").encode())
    if plan.get("npmPlanSha256") != npm.get("planSha256"):
        raise RuntimeError("Docker plan and npm completion name different npm manifests")
    expected_images = core_images(config)
    if [entry.get("image") for entry in plan.get("images", [])] != expected_images:
        raise RuntimeError("recorded Docker plan does not contain the configured 31 core images")

    verified = []
    for image in expected_images:
        reference = reference_for(config, image, version)
        run(["docker", "image", "rm", "--force", reference], check=False, capture=True)
        run(["docker", "pull", reference])
        inspected = inspect_image(reference)
        verify_labels(
            reference, inspected, expected_labels(image, version, source_hash, frontend_hash)
        )
        verify_embedded_manifest(image, reference, frontend_hash)
        verified.append({
            "image": image,
            "reference": reference,
            "digest": repository_digest(reference, inspected),
            "platform": f"{inspected.get('Os')}/{inspected.get('Architecture')}",
            "sourceRevision": (inspected.get("Config", {}).get("Labels") or {}).get(
                "org.opencontainers.image.revision"
            ),
        })
        run(["docker", "image", "rm", "--force", reference], check=False, capture=True)

    completed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    completion = {
        "schemaVersion": 2,
        "version": version,
        "completedAt": completed_at,
        "plan": f"docker/trains/{version}.json",
        "sourceManifestSha256": source_hash,
        "npmPlanSha256": npm["planSha256"],
        "frontendManifestSha256": frontend_hash,
        "images": verified,
    }
    write_json(args.state / "docker" / "completed" / f"{version}.json", completion)
    current_path = args.state / "docker" / "current.json"
    current = load_json(current_path) if current_path.exists() else None
    if current is None or train_key(version) > train_key(current["version"]):
        write_json(current_path, {
            "schemaVersion": 1,
            "version": version,
            "completedAt": completed_at,
            "plan": f"docker/trains/{version}.json",
            "completion": f"docker/completed/{version}.json",
        })
    else:
        print(f"Verified {version}, but kept newer current Docker train {current['version']}.")
    print(f"Docker train {version} is complete with {len(verified)} immutable image digests.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    commands = result.add_subparsers(dest="command", required=True)

    matrix_parser = commands.add_parser("matrix")
    matrix_parser.add_argument("--group", required=True)
    matrix_parser.set_defaults(handler=matrix)

    plan_parser = commands.add_parser("record-plan")
    plan_parser.add_argument("--version", required=True)
    plan_parser.add_argument("--state", type=Path, required=True)
    plan_parser.set_defaults(handler=record_plan)

    checkout_parser = commands.add_parser("checkout")
    checkout_parser.add_argument("--version", required=True)
    checkout_parser.add_argument("--workspace", type=Path, required=True)
    checkout_parser.add_argument("--state", type=Path)
    checkout_parser.set_defaults(handler=checkout)

    publish_parser = commands.add_parser("publish-image")
    publish_parser.add_argument("--version", required=True)
    publish_parser.add_argument("--image", required=True)
    publish_parser.add_argument("--workspace", type=Path, required=True)
    publish_parser.set_defaults(handler=publish_image)

    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--version", required=True)
    verify_parser.add_argument("--state", type=Path, required=True)
    verify_parser.set_defaults(handler=verify)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
