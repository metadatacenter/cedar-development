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
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

try:
    from subprocess_diagnostics import describe_return_code
except ModuleNotFoundError:  # Loaded directly by the unit-test harness.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from subprocess_diagnostics import describe_return_code


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "frontend-train.json"
TRAIN_RE = re.compile(r"^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$")
PACKAGE_VERSION_RE = re.compile(r"^(\d+\.\d+\.\d+)(?:[-+].*)?$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
FRONTEND_PACKAGE_FORMAT = "p3"
WIRED_FRONTEND_PACKAGE_FORMAT = "p4"


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


def package_base(version: str, identity: str) -> str:
    match = PACKAGE_VERSION_RE.fullmatch(version or "")
    if not match:
        raise RuntimeError(f"{identity} has invalid package version {version!r}")
    return match.group(1)


def train_package_version(source_version: str, train: str, revision: str,
                          package_format: str | None = None) -> str:
    validate_train(train)
    if not SHA_RE.fullmatch(revision or ""):
        raise RuntimeError(f"invalid package source revision {revision!r}")
    base = package_base(source_version, "source package")
    train_day, train_minute = train.split("-dev.", 1)[1].split(".", 1)
    # A four-digit UTC time can begin with zero, but SemVer numeric prerelease
    # identifiers cannot. Keep the human-facing train ID unchanged and use one
    # combined, always-valid timestamp identifier for its npm packages.
    package_timestamp = f"{train_day}{train_minute}"
    result = f"{base}-dev.{package_timestamp}.g{revision[:12]}"
    if package_format:
        result += f".{package_format}"
    return result


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


def wired_frontend_version(manifest_version: str, train: str, revision: str) -> str:
    return train_package_version(
        manifest_version, train, revision, WIRED_FRONTEND_PACKAGE_FORMAT,
    )


def record_plan(args: argparse.Namespace) -> None:
    config = load_json(args.config)
    source, source_content = source_manifest(args.state, args.version)

    model_root, model_revision = repository_root(
        args.workspace, source, config["model"]["repository"]
    )
    model_source = load_json(model_root / config["model"]["sourceManifest"])
    model_package = load_json(model_root / config["model"]["publishedManifest"])
    model_name = model_package["name"]
    if not model_name.startswith("@org.metadatacenter/"):
        raise RuntimeError("TypeScript model development package must use the Nexus scope")
    model_source_version = model_source.get("version")
    if package_base(model_source_version, "TypeScript model source") != package_base(
        model_package.get("version"), "TypeScript model published manifest"
    ):
        raise RuntimeError("TypeScript model source and published manifests have different bases")
    model_version = train_package_version(
        model_source_version, args.version, model_revision,
    )

    cee_root, cee_revision = repository_root(args.workspace, source, config["cee"]["repository"])
    cee_source = load_json(cee_root / config["cee"]["sourceManifest"])
    cee_name = config["cee"]["publishedName"]
    if not cee_name.startswith("@org.metadatacenter/"):
        raise RuntimeError("CEE development package must use the Nexus scope")
    cee_source_version = cee_source.get("version")
    cee_version = train_package_version(
        cee_source_version, args.version, cee_revision,
    )
    packages = []
    additional_consumers = []
    cee_consumers = []
    docker_inputs = dict(source.get("frontendPackages", {}))
    for frontend in config["frontends"]:
        frontend_root, revision = repository_root(args.workspace, source, frontend["repository"])
        manifest = load_json(frontend_root / frontend["packagePath"] / "package.json")
        expected_version = (
            wired_frontend_version(manifest["version"], args.version, revision)
            if "ceeConsumer" in frontend
            else frontend_version(frontend_root, manifest["version"], revision)
        )
        if "ceeConsumer" in frontend:
            consumer = frontend["ceeConsumer"]
            cee_consumers.append({
                "label": frontend["id"],
                "repository": frontend["repository"],
                "revision": revision,
                "manifest": consumer["manifest"],
                "lock": consumer["lock"],
                "legacyPeerDeps": bool(consumer.get("legacyPeerDeps", False)),
                "publishedFrontend": frontend["id"],
            })
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
            **(
                {"preparedBuild": frontend["preparedBuild"]}
                if frontend.get("preparedBuild") else {}
            ),
        })
    for consumer in config.get("additionalCeeConsumers", []):
        consumer_root, revision = repository_root(
            args.workspace, source, consumer["repository"]
        )
        record = {
            "label": consumer.get("label", consumer["manifest"]),
            "repository": consumer["repository"],
            "revision": revision,
            "manifest": consumer["manifest"],
            "lock": consumer["lock"],
            "legacyPeerDeps": bool(consumer.get("legacyPeerDeps", False)),
            "ceeVersion": cee_version,
        }
        additional_consumers.append(record)
        cee_consumers.append(record)
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
        "schemaVersion": 2,
        "version": validate_train(args.version),
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceManifest": f"trains/{args.version}.json",
        "sourceManifestSha256": sha256_bytes(source_content),
        "registry": config["registry"],
        "model": {
            "name": model_name,
            "version": model_version,
            "sourceVersion": model_source_version,
            "repository": config["model"]["repository"],
            "revision": model_revision,
            "publication": "train-owned",
        },
        "cee": {
            "name": cee_name,
            "version": cee_version,
            "sourceVersion": cee_source_version,
            "repository": config["cee"]["repository"],
            "revision": cee_revision,
            "publication": "train-owned",
            "model": {"name": model_name, "version": model_version},
            "modelConsumers": [
                {
                    "manifest": config["cee"]["sourceManifest"],
                    "lock": config["cee"]["sourceLock"],
                },
                *config["cee"].get("additionalModelConsumers", []),
            ],
        },
        "frontends": packages,
        "runtimePackages": runtime_packages,
        "additionalCeeConsumers": additional_consumers,
        "ceeConsumers": cee_consumers,
        "wiringPolicy": {
            "workspace": "isolated exact-commit checkouts",
            "sourceRepositoriesModified": False,
            "modelIntoCee": "exact Nexus alias and lock integrity",
            "ceeIntoFrontends": "exact Nexus alias and lock integrity",
        },
        "dockerInputs": dict(sorted(docker_inputs.items())),
    }
    destination = args.state / "npm" / "trains" / f"{args.version}.json"
    if destination.exists():
        existing = load_json(destination)
        comparable_existing = {
            key: existing.get(key) for key in plan if key != "createdAt"
        }
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


def run_command(command: list[str], cwd: Path, environment: dict | None = None) -> None:
    effective_environment = dict(os.environ if environment is None else environment)
    effective_environment["CI"] = "true"
    effective_environment["NG_CLI_ANALYTICS"] = "false"
    result = subprocess.run(
        command, cwd=cwd, env=effective_environment, check=False,
    )
    if result.returncode:
        raise RuntimeError(
            f"command {describe_return_code(result.returncode)}: "
            f"{' '.join(command)}"
        )


def assert_clean_repository(root: Path, identity: str) -> None:
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=root, text=True, capture_output=True, check=True,
    ).stdout.strip()
    if status:
        raise RuntimeError(f"isolated {identity} checkout is dirty before preparation")


def write_pretty_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def stamp_package_version(root: Path, version: str, published_manifest: str | None = None) -> None:
    package_path = root / "package.json"
    lock_path = root / "package-lock.json"
    package = load_json(package_path)
    lock = load_json(lock_path)
    package["version"] = version
    lock["version"] = version
    lock_root = lock.get("packages", {}).get("")
    if not isinstance(lock_root, dict):
        raise RuntimeError(f"{lock_path} has no root package record")
    lock_root["version"] = version
    write_pretty_json(package_path, package)
    write_pretty_json(lock_path, lock)
    if published_manifest:
        published_path = root / published_manifest
        published = load_json(published_path)
        published["version"] = version
        write_pretty_json(published_path, published)


def install_exact_alias(root: Path, dependency: str, published_name: str, version: str,
                        legacy_peer_deps: bool = False) -> None:
    spec = f"{dependency}@npm:{published_name}@{version}"
    command = [
        "npm", "install", "--package-lock-only", "--ignore-scripts", "--save-exact", spec,
    ]
    if legacy_peer_deps:
        command.append("--legacy-peer-deps")
    run_command(command, root)


def existing_verified_package(registry: str, expected: dict) -> bool:
    if registry_record(registry, expected["name"], expected["version"]) is None:
        return False
    verify_record(registry, expected)
    print(f"Already published and verified: {expected['name']}@{expected['version']}")
    return True


def record_library_completion(state: Path, stage: str, plan: dict,
                              expected: dict, verified: dict) -> None:
    write_json(state / "npm" / stage / "completed" / f"{plan['version']}.json", {
        "schemaVersion": 1,
        "version": plan["version"],
        "stage": stage,
        "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceManifestSha256": plan.get("sourceManifestSha256"),
        "package": verified,
        "expected": {
            "name": expected["name"],
            "version": expected["version"],
            "repository": expected["repository"],
            "revision": expected["revision"],
        },
    })


def publish_model(args: argparse.Namespace) -> None:
    plan = load_json(args.state / "npm" / "trains" / f"{validate_train(args.version)}.json")
    expected = plan["model"]
    if existing_verified_package(plan["registry"], expected):
        verified = verify_record(plan["registry"], expected)
        record_library_completion(args.state, "model", plan, expected, verified)
        return
    source, _ = source_manifest(args.state, args.version)
    root, revision = repository_root(args.workspace, source, expected["repository"])
    if revision != expected["revision"]:
        raise RuntimeError("TypeScript model plan and source manifest disagree")
    assert_clean_repository(root, "TypeScript model")
    stamp_package_version(root, expected["version"], "package-dist.json")
    published = load_json(root / "package-dist.json")
    if published.get("name") != expected["name"]:
        raise RuntimeError("TypeScript model published manifest has the wrong scoped name")
    for command in (
        ["npm", "ci"],
        ["npm", "run", "lint"],
        ["npm", "run", "typecheck"],
        ["npm", "run", "test:coverage"],
        ["npm", "run", "parity:yaml"],
        ["npm", "run", "parity:json"],
        ["npm", "run", "test:package"],
    ):
        run_command(command, root)
    built = load_json(root / "dist" / "package.json")
    if built.get("name") != expected["name"] or built.get("version") != expected["version"]:
        raise RuntimeError("built TypeScript model package has the wrong identity")
    run_command([
        "npm", "publish", "./dist", "--tag", "dev",
        "--registry", plan["registry"], "--loglevel=notice",
    ], root)
    verified = verify_record(plan["registry"], expected)
    record_library_completion(args.state, "model", plan, expected, verified)
    print(f"Published train model: {expected['name']}@{expected['version']}")


def publish_cee(args: argparse.Namespace) -> None:
    plan = load_json(args.state / "npm" / "trains" / f"{validate_train(args.version)}.json")
    expected = plan["cee"]
    # CEE completion is evidence for the whole model -> CEE edge, including on resume.
    verify_record(plan["registry"], plan["model"])
    if existing_verified_package(plan["registry"], expected):
        verified = verify_record(plan["registry"], expected)
        record_library_completion(args.state, "cee", plan, expected, verified)
        return
    source, _ = source_manifest(args.state, args.version)
    root, revision = repository_root(args.workspace, source, expected["repository"])
    if revision != expected["revision"]:
        raise RuntimeError("CEE plan and source manifest disagree")
    assert_clean_repository(root, "CEE")
    stamp_package_version(root, expected["version"])
    config = load_json(args.config)
    dependency = config["cee"]["modelDependency"]
    for consumer in expected["modelConsumers"]:
        consumer_root = (root / consumer["manifest"]).parent
        install_exact_alias(
            consumer_root, dependency, plan["model"]["name"], plan["model"]["version"],
            bool(consumer.get("legacyPeerDeps", False)),
        )
        require_exact_alias(
            root / consumer["manifest"], root / consumer["lock"], dependency,
            plan["model"]["name"], plan["model"]["version"],
        )
    for command, cwd in (
        (["npm", "ci"], root),
        (["npm", "--prefix", "harness", "ci"], root),
        (["npm", "--prefix", "visual", "ci"], root),
        (["npm", "run", "test:ci"], root),
        (["npm", "run", "audit:prod"], root),
    ):
        run_command(command, cwd)
    staged = root / "dist-npm" / "cedar-embeddable-editor"
    built = load_json(staged / "package.json")
    if built.get("name") != expected["name"] or built.get("version") != expected["version"]:
        raise RuntimeError("built CEE package has the wrong train identity")
    run_command([
        "npm", "publish", str(staged), "--tag", "dev",
        "--registry", plan["registry"], "--loglevel=notice",
    ], root)
    verified = verify_record(plan["registry"], expected)
    record_library_completion(args.state, "cee", plan, expected, verified)
    print(f"Published train CEE: {expected['name']}@{expected['version']}")


def path_sha256(path: Path) -> str:
    if path.is_file():
        return sha256_bytes(path.read_bytes())
    if not path.is_dir():
        raise RuntimeError(f"prepared package input is missing: {path}")
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix()
        if any(part in {".git", "node_modules"} for part in child.relative_to(path).parts):
            continue
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(child.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def replace_prepared_dist(source: Path, destination: Path) -> None:
    if not source.is_dir() or not destination.is_dir():
        raise RuntimeError(f"cannot stage frontend build from {source} to {destination}")
    preserved = {"package.json", "package-lock.json", "README.md", "license.txt"}
    for child in destination.iterdir():
        if child.name in preserved:
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in source.iterdir():
        target = destination / child.name
        if child.is_dir():
            shutil.copytree(child, target)
        else:
            shutil.copy2(child, target)


def prepare_frontends(args: argparse.Namespace) -> None:
    version = validate_train(args.version)
    plan_path = args.state / "npm" / "trains" / f"{version}.json"
    plan = load_json(plan_path)
    verify_record(plan["registry"], plan["cee"])
    source, _ = source_manifest(args.state, version)
    wiring = []
    by_frontend: dict[str, list[str]] = {}
    for consumer in plan["ceeConsumers"]:
        repository_root(args.workspace, source, consumer["repository"])
        manifest_path = args.workspace / consumer["repository"] / consumer["manifest"]
        lock_path = args.workspace / consumer["repository"] / consumer["lock"]
        install_exact_alias(
            manifest_path.parent,
            "cedar-embeddable-editor",
            plan["cee"]["name"],
            plan["cee"]["version"],
            consumer["legacyPeerDeps"],
        )
        require_exact_alias(
            manifest_path, lock_path, "cedar-embeddable-editor",
            plan["cee"]["name"], plan["cee"]["version"],
        )
        record = {
            **consumer,
            "manifestSha256": path_sha256(manifest_path),
            "lockSha256": path_sha256(lock_path),
        }
        wiring.append(record)
        if consumer.get("publishedFrontend"):
            by_frontend.setdefault(consumer["publishedFrontend"], []).extend([
                consumer["manifest"], consumer["lock"],
            ])

    builds = []
    for frontend in plan["frontends"]:
        build = frontend.get("preparedBuild")
        if not build:
            continue
        root = args.workspace / frontend["repository"]
        build_root = root / build["directory"]
        for command in build["commands"]:
            run_command(command, build_root)
        output = root / build["output"]
        destination = root / frontend["packagePath"]
        replace_prepared_dist(output, destination)
        by_frontend[frontend["id"]] = [frontend["packagePath"]]
        builds.append({
            "frontend": frontend["id"],
            "repository": frontend["repository"],
            "output": frontend["packagePath"],
            "sha256": path_sha256(destination),
        })

    overlays = {
        frontend["id"]: sorted(set(by_frontend.get(frontend["id"], [])))
        for frontend in plan["frontends"]
    }
    evidence = {
        "preparedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "ceeVersion": plan["cee"]["version"],
        "consumers": wiring,
        "builds": builds,
        "overlays": overlays,
    }
    existing = plan.get("frontendPreparation")
    if existing:
        comparable_existing = {k: v for k, v in existing.items() if k != "preparedAt"}
        comparable_evidence = {k: v for k, v in evidence.items() if k != "preparedAt"}
        if comparable_existing != comparable_evidence:
            raise RuntimeError("prepared frontend wiring differs from the recorded npm plan")
        print(f"Frontend wiring for {version} matches the recorded preparation.")
        return
    plan["frontendPreparation"] = evidence
    write_json(plan_path, plan)
    print(f"Prepared and recorded {len(wiring)} exact CEE consumer locks.")


def verify_frontend_preparation(plan: dict, workspace: Path) -> None:
    preparation = plan.get("frontendPreparation")
    if not isinstance(preparation, dict) or preparation.get("ceeVersion") != plan["cee"]["version"]:
        raise RuntimeError("frontends have not been prepared against the train CEE")
    for consumer in preparation.get("consumers", []):
        root = workspace / consumer["repository"]
        if path_sha256(root / consumer["manifest"]) != consumer["manifestSha256"]:
            raise RuntimeError(f"prepared manifest changed for {consumer['repository']}")
        if path_sha256(root / consumer["lock"]) != consumer["lockSha256"]:
            raise RuntimeError(f"prepared lock changed for {consumer['repository']}")
    for build in preparation.get("builds", []):
        if path_sha256(workspace / build["repository"] / build["output"]) != build["sha256"]:
            raise RuntimeError(f"prepared build changed for {build['repository']}")


def publish_frontends(args: argparse.Namespace) -> None:
    plan = load_json(args.state / "npm" / "trains" / f"{validate_train(args.version)}.json")
    registry = plan["registry"]
    verify_frontend_preparation(plan, args.workspace)
    for library in (plan["model"], plan["cee"]):
        verify_record(registry, library)
        print(f"Verified train-published library: {library['name']}@{library['version']}")
    helper = ROOT / "publish-frontend-package.sh"
    environment = os.environ.copy()
    environment["CEDAR_HOME"] = str(args.workspace)
    overlays = plan["frontendPreparation"]["overlays"]
    for frontend in plan["frontends"]:
        existing = registry_record(registry, frontend["name"], frontend["version"])
        if existing is not None:
            if existing.get("gitHead") != frontend["revision"]:
                raise RuntimeError(
                    f"{frontend['name']}@{frontend['version']} exists with a different gitHead"
                )
            print(f"Frontend already exists: {frontend['name']}@{frontend['version']}")
            continue
        package_environment = dict(environment)
        package_environment["CEDAR_TRAIN_PACKAGE_VERSION"] = frontend["version"]
        package_environment["CEDAR_TRAIN_OVERLAY_PATHS"] = ":".join(overlays[frontend["id"]])
        subprocess.run([str(helper), frontend["id"]], env=package_environment, check=True)


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
    model = commands.add_parser("publish-model")
    model.add_argument("--version", required=True)
    model.add_argument("--workspace", type=Path, required=True)
    model.add_argument("--state", type=Path, required=True)
    model.set_defaults(handler=publish_model)
    cee = commands.add_parser("publish-cee")
    cee.add_argument("--version", required=True)
    cee.add_argument("--workspace", type=Path, required=True)
    cee.add_argument("--state", type=Path, required=True)
    cee.set_defaults(handler=publish_cee)
    prepare = commands.add_parser("prepare-frontends")
    prepare.add_argument("--version", required=True)
    prepare.add_argument("--workspace", type=Path, required=True)
    prepare.add_argument("--state", type=Path, required=True)
    prepare.set_defaults(handler=prepare_frontends)
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
