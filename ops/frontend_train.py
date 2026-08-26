#!/usr/bin/env python3
"""Plan, publish, and verify the immutable npm portion of a CEDAR build train."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "frontend-train.json"
TRAIN_RE = re.compile(r"^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
FRONTEND_PACKAGE_FORMAT = "p2"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def canonical_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


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


def source_manifest(state: Path, version: str) -> tuple[dict, bytes]:
    path = state / "trains" / f"{validate_train(version)}.json"
    if not path.exists():
        raise RuntimeError(f"train {version} has no source manifest")
    content = path.read_bytes()
    return json.loads(content), content


def repository_root(workspace: Path, source: dict, repository: str) -> tuple[Path, str]:
    revision = source.get("repositories", {}).get(repository, "")
    if not SHA_RE.fullmatch(revision):
        raise RuntimeError(f"source manifest has no valid commit for {repository}")
    root = workspace / repository
    if not (root / ".git").exists():
        raise RuntimeError(f"train workspace has no checkout for {repository}")
    actual = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True, capture_output=True, check=True
    ).stdout.strip()
    if actual != revision:
        raise RuntimeError(f"{repository} checkout is {actual}, expected {revision}")
    return root, revision


def require_exact_alias(manifest: Path, lock: Path, local_name: str,
                        published_name: str, version: str) -> None:
    expected = f"npm:{published_name}@{version}"
    package = load_json(manifest)
    declared = package.get("dependencies", {}).get(local_name)
    if declared != expected:
        raise RuntimeError(f"{manifest} must pin {local_name} exactly to {expected}; found {declared!r}")
    locked = load_json(lock)
    root = locked.get("packages", {}).get("", {})
    if root.get("dependencies", {}).get(local_name) != expected:
        raise RuntimeError(f"{lock} root dependency does not match {expected}")
    installed = locked.get("packages", {}).get(f"node_modules/{local_name}", {})
    if installed.get("version") != version or not installed.get("integrity"):
        raise RuntimeError(f"{lock} does not lock {local_name}@{version} with integrity")


def frontend_version(repository: Path, manifest_version: str, revision: str) -> str:
    base = manifest_version.removesuffix("-SNAPSHOT").split("-", 1)[0]
    timestamp = subprocess.run(
        ["git", "show", "-s", "--format=%cd", "--date=format:%Y%m%d%H%M%S", revision],
        cwd=repository, text=True, capture_output=True, check=True,
    ).stdout.strip()
    return f"{base}-dev.{timestamp}.g{revision[:12]}.{FRONTEND_PACKAGE_FORMAT}"


def record_plan(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    source, source_content = source_manifest(args.state, args.version)

    model_root, model_revision = repository_root(
        args.workspace, source, config["model"]["repository"]
    )
    model_source = load_json(model_root / config["model"]["sourceManifest"])
    model_package = load_json(model_root / config["model"]["publishedManifest"])
    if model_source.get("version") != model_package.get("version"):
        raise RuntimeError("TypeScript model source and published manifests have different versions")

    cee_root, cee_revision = repository_root(args.workspace, source, config["cee"]["repository"])
    cee_source = load_json(cee_root / config["cee"]["sourceManifest"])
    model_name = model_package["name"]
    model_version = model_package["version"]
    model_registry = registry_record(config["registry"], model_name, model_version)
    if model_registry is None or not SHA_RE.fullmatch(model_registry.get("gitHead", "")):
        raise RuntimeError(f"publish {model_name}@{model_version} through its library release gate first")
    model_artifact_revision = model_registry["gitHead"]
    require_exact_alias(
        cee_root / config["cee"]["sourceManifest"],
        cee_root / config["cee"]["sourceLock"],
        config["cee"]["modelDependency"], model_name, model_version,
    )
    for consumer in config["cee"].get("additionalModelConsumers", []):
        require_exact_alias(
            cee_root / consumer["manifest"], cee_root / consumer["lock"],
            config["cee"]["modelDependency"], model_name, model_version,
        )

    cee_name = config["cee"]["publishedName"]
    cee_version = cee_source["version"]
    cee_registry = registry_record(config["registry"], cee_name, cee_version)
    if cee_registry is None or not SHA_RE.fullmatch(cee_registry.get("gitHead", "")):
        raise RuntimeError(f"publish {cee_name}@{cee_version} through its library release gate first")
    cee_artifact_revision = cee_registry["gitHead"]
    packages = []
    additional_consumers = []
    docker_inputs = dict(source.get("frontendPackages", {}))
    for frontend in config["frontends"]:
        frontend_root, revision = repository_root(args.workspace, source, frontend["repository"])
        manifest = load_json(frontend_root / frontend["packagePath"] / "package.json")
        expected_version = frontend_version(frontend_root, manifest["version"], revision)
        if "ceeConsumer" in frontend:
            consumer = frontend["ceeConsumer"]
            require_exact_alias(
                frontend_root / consumer["manifest"], frontend_root / consumer["lock"],
                "cedar-embeddable-editor", cee_name, cee_version,
            )
        docker_inputs[frontend["npmVersionVariable"]] = expected_version
        packages.append({
            "id": frontend["id"],
            "image": frontend["image"],
            "name": manifest["name"],
            "version": expected_version,
            "repository": frontend["repository"],
            "revision": revision,
            "packagePath": frontend["packagePath"],
            "npmVersionVariable": frontend["npmVersionVariable"],
            "ceeVersion": cee_version if "ceeConsumer" in frontend else None,
            "requiresShrinkwrap": True,
        })
    for consumer in config.get("additionalCeeConsumers", []):
        consumer_root, revision = repository_root(
            args.workspace, source, consumer["repository"]
        )
        require_exact_alias(
            consumer_root / consumer["manifest"], consumer_root / consumer["lock"],
            "cedar-embeddable-editor", cee_name, cee_version,
        )
        additional_consumers.append({
            "repository": consumer["repository"],
            "revision": revision,
            "manifest": consumer["manifest"],
            "ceeVersion": cee_version,
        })
    docker_inputs[config["dockerCeeVersionVariable"]] = cee_version
    runtime_packages = []
    for package in config.get("runtimePackages", []):
        version_variable = package["versionVariable"]
        version = docker_inputs.get(version_variable)
        if not version:
            raise RuntimeError(
                f"runtime package {package['name']} has no Docker input {version_variable}"
            )
        runtime_packages.append({
            "name": package["name"],
            "version": version,
            "registry": package["registry"],
        })

    plan = {
        "schemaVersion": 1,
        "version": validate_train(args.version),
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceManifest": f"trains/{args.version}.json",
        "sourceManifestSha256": sha256_bytes(source_content),
        "registry": config["registry"],
        "model": {
            "name": model_name, "version": model_version,
            "repository": config["model"]["repository"], "revision": model_artifact_revision,
            "capturedRevision": model_revision,
        },
        "cee": {
            "name": cee_name, "version": cee_version,
            "repository": config["cee"]["repository"], "revision": cee_artifact_revision,
            "capturedRevision": cee_revision,
            "model": {"name": model_name, "version": model_version},
        },
        "frontends": packages,
        "runtimePackages": runtime_packages,
        "additionalCeeConsumers": additional_consumers,
        "dockerInputs": dict(sorted(docker_inputs.items())),
    }
    destination = args.state / "npm" / "trains" / f"{args.version}.json"
    if destination.exists():
        existing = load_json(destination)
        comparable_existing = {k: v for k, v in existing.items() if k != "createdAt"}
        comparable_plan = {k: v for k, v in plan.items() if k != "createdAt"}
        if comparable_existing != comparable_plan:
            raise RuntimeError(f"recorded npm plan for {args.version} differs from current inputs")
        print(f"npm plan for {args.version} is already recorded.")
        return
    write_json(destination, plan)
    print(
        f"Recorded npm dependency graph with "
        f"{len(packages) + len(runtime_packages) + 2} immutable packages."
    )


def authorization_header() -> dict[str, str]:
    username = os.environ.get("BMIR_NEXUS_USERNAME")
    password = os.environ.get("BMIR_NEXUS_PASSWORD")
    if not username or not password:
        return {}
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def fetch(url: str, missing_ok: bool = False) -> bytes | None:
    request = urllib.request.Request(url, headers=authorization_header())
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise


def registry_record(registry: str, name: str, version: str) -> dict | None:
    metadata_url = registry.rstrip("/") + "/" + urllib.parse.quote(name, safe="")
    content = fetch(metadata_url, missing_ok=True)
    if content is None:
        return None
    metadata = json.loads(content)
    return metadata.get("versions", {}).get(version)


def verify_record(registry: str, expected: dict) -> dict:
    record = registry_record(registry, expected["name"], expected["version"])
    identity = f"{expected['name']}@{expected['version']}"
    if record is None:
        raise RuntimeError(f"npm registry is missing {identity}")
    revision = expected.get("revision")
    if revision and record.get("gitHead") != revision:
        raise RuntimeError(
            f"{identity} gitHead is {record.get('gitHead')!r}, expected {revision}"
        )
    distribution = record.get("dist", {})
    tarball_url = distribution.get("tarball")
    integrity = distribution.get("integrity")
    if not tarball_url or not integrity:
        raise RuntimeError(f"{identity} has no tarball and integrity metadata")
    tarball = fetch(tarball_url)
    algorithm, encoded = integrity.split("-", 1)
    if algorithm not in hashlib.algorithms_available:
        raise RuntimeError(f"{identity} uses unsupported integrity algorithm {algorithm}")
    actual_integrity = base64.b64encode(hashlib.new(algorithm, tarball).digest()).decode()
    if actual_integrity != encoded:
        raise RuntimeError(f"{identity} tarball does not match registry integrity")
    shrinkwrap_sha256 = None
    if expected.get("requiresShrinkwrap"):
        try:
            with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
                shrinkwrap = archive.extractfile("package/npm-shrinkwrap.json")
                if shrinkwrap is None:
                    raise KeyError("package/npm-shrinkwrap.json")
                shrinkwrap_sha256 = sha256_bytes(shrinkwrap.read())
        except (KeyError, tarfile.TarError) as error:
            raise RuntimeError(f"{identity} tarball has no readable npm-shrinkwrap.json") from error
    verified = {
        "name": expected["name"],
        "version": expected["version"],
        "integrity": integrity,
        "tarball": tarball_url,
        "tarballSha256": sha256_bytes(tarball),
    }
    for field in ("repository", "revision"):
        if expected.get(field):
            verified[field] = expected[field]
    if shrinkwrap_sha256:
        verified["shrinkwrapSha256"] = shrinkwrap_sha256
    return verified


def publish_frontends(args: argparse.Namespace) -> None:
    plan = load_json(args.state / "npm" / "trains" / f"{validate_train(args.version)}.json")
    registry = plan["registry"]
    # The model and CEE are independent libraries with their own full release gates. A train may
    # consume them only after those immutable artifacts exist; it never bypasses their gates.
    for library in (plan["model"], plan["cee"]):
        try:
            verify_record(registry, library)
        except RuntimeError as error:
            raise RuntimeError(
                f"publish or repair {library['name']}@{library['version']} through its library "
                f"release gate first: {error}"
            ) from error
        print(f"Verified library prerequisite: {library['name']}@{library['version']}")
    helper = ROOT / "publish-frontend-package.sh"
    environment = os.environ.copy()
    environment["CEDAR_HOME"] = str(args.workspace)
    for frontend in plan["frontends"]:
        existing = registry_record(registry, frontend["name"], frontend["version"])
        if existing is not None:
            if existing.get("gitHead") != frontend["revision"]:
                raise RuntimeError(
                    f"{frontend['name']}@{frontend['version']} exists with a different gitHead"
                )
            print(f"Frontend already exists: {frontend['name']}@{frontend['version']}")
            continue
        subprocess.run([str(helper), frontend["id"]], env=environment, check=True)


def complete(args: argparse.Namespace) -> None:
    version = validate_train(args.version)
    plan_path = args.state / "npm" / "trains" / f"{version}.json"
    if not plan_path.exists():
        raise RuntimeError(f"npm train {version} has no recorded plan")
    plan_content = plan_path.read_bytes()
    plan = json.loads(plan_content)
    verified = []
    for expected in (plan["model"], plan["cee"], *plan["frontends"]):
        verified.append(verify_record(plan["registry"], expected))
    for expected in plan.get("runtimePackages", []):
        verified.append(verify_record(expected["registry"], expected))
    completed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    completion = {
        "schemaVersion": 1,
        "version": version,
        "completedAt": completed_at,
        "plan": f"npm/trains/{version}.json",
        "planSha256": sha256_bytes(plan_content),
        "sourceManifestSha256": plan["sourceManifestSha256"],
        "dockerInputs": plan["dockerInputs"],
        "packages": verified,
    }
    write_json(args.state / "npm" / "completed" / f"{version}.json", completion)
    current_path = args.state / "npm" / "current.json"
    current = load_json(current_path) if current_path.exists() else None
    if current is None or train_key(version) > train_key(current["version"]):
        write_json(current_path, {
            "schemaVersion": 1, "version": version, "completedAt": completed_at,
            "plan": f"npm/trains/{version}.json",
            "completion": f"npm/completed/{version}.json",
            "planSha256": completion["planSha256"],
        })
    print(f"npm train {version} is complete with {len(verified)} verified tarballs.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    commands = result.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("record-plan")
    plan.add_argument("--version", required=True)
    plan.add_argument("--workspace", type=Path, required=True)
    plan.add_argument("--state", type=Path, required=True)
    plan.set_defaults(handler=record_plan)
    publish = commands.add_parser("publish-frontends")
    publish.add_argument("--version", required=True)
    publish.add_argument("--workspace", type=Path, required=True)
    publish.add_argument("--state", type=Path, required=True)
    publish.set_defaults(handler=publish_frontends)
    finish = commands.add_parser("complete")
    finish.add_argument("--version", required=True)
    finish.add_argument("--state", type=Path, required=True)
    finish.set_defaults(handler=complete)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError,
            urllib.error.URLError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
