#!/usr/bin/env python3
"""Create and resume immutable CEDAR development build trains."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

try:
    from subprocess_diagnostics import describe_return_code
except ModuleNotFoundError:  # Loaded directly by the unit-test harness.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from subprocess_diagnostics import describe_return_code


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "build-train.json"
DEFAULT_FRONTEND_CONFIG = ROOT / "frontend-train.json"
DEFAULT_DOCKER_CONFIG = ROOT / "docker-train.json"
TRAIN_RE = re.compile(r"^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$")
MAVEN_NS = "http://maven.apache.org/POM/4.0.0"
NPM_INPUT_RE = re.compile(r"^export (CEDAR_[A-Z0-9_]+_NPM_VERSION)=(\S+)$", re.MULTILINE)
NEXUS_HOST = "https://nexus.bmir.stanford.edu"
NEXUS_MAVEN_TRAIN_REPOSITORY = f"{NEXUS_HOST}/repository/cedar-maven-dev/"
NEXUS_NPM_REPOSITORY = f"{NEXUS_HOST}/repository/npm-cedar/"
NEXUS_DOCKER_V2 = f"{NEXUS_HOST}/v2/"


def run(arguments: list[str], cwd: Path | None = None, capture: bool = False) -> str:
    print("+", " ".join(arguments), f"(in {cwd})" if cwd else "", flush=True)
    result = subprocess.run(
        arguments,
        cwd=cwd,
        text=True,
        capture_output=capture,
        check=False,
    )
    if result.returncode:
        if capture:
            sys.stderr.write(result.stderr)
        no_output = (
            "; the process produced no diagnostic output of its own"
            if capture and result.returncode < 0 and not (result.stdout or result.stderr) else ""
        )
        raise RuntimeError(
            f"command {describe_return_code(result.returncode)}{no_output}: "
            f"{' '.join(arguments)}"
        )
    return result.stdout.strip() if capture else ""


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def _unique_strings(value, label: str) -> list[str]:
    if (
        not isinstance(value, list) or not value
        or not all(isinstance(item, str) and item for item in value)
        or len(value) != len(set(value))
    ):
        raise RuntimeError(f"{label} must be a non-empty unique string list")
    return value


def _safe_relative(value, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{label} must be a non-empty relative path")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"{label} is not a safe relative path: {value!r}")
    return value


def _require_file(workspace: Path, repository: str, relative: str, label: str) -> Path:
    path = workspace / repository / _safe_relative(relative, label)
    if not path.is_file():
        raise RuntimeError(f"{label} is missing from {repository}: {relative}")
    return path


def validate_audit_baselines(frontend: dict, workspace: Path,
                             repositories: list[str]) -> int:
    """Bind reviewed npm advisory counts to the exact dependency graphs that produced them."""
    baselines = frontend.get("auditBaselines")
    if not isinstance(baselines, list) or not baselines:
        raise RuntimeError("frontend train must declare npm audit baselines")
    seen = set()
    severities = {"low", "moderate", "high", "critical"}
    for baseline in baselines:
        if not isinstance(baseline, dict):
            raise RuntimeError(f"invalid npm audit baseline: {baseline!r}")
        repository = baseline.get("repository")
        if repository not in repositories:
            raise RuntimeError(
                f"npm audit baseline repository is absent from source train: {repository}")
        relative = _safe_relative(baseline.get("lock"), "npm audit baseline lock")
        identity = (repository, relative)
        if identity in seen:
            raise RuntimeError(f"duplicate npm audit baseline: {repository}:{relative}")
        seen.add(identity)
        expected = baseline.get("sha256")
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise RuntimeError(f"invalid npm audit baseline digest for {repository}:{relative}")
        counts = baseline.get("vulnerabilities")
        if (
            not isinstance(counts, dict) or set(counts) != severities
            or any(not isinstance(value, int) or value < 0 for value in counts.values())
        ):
            raise RuntimeError(f"invalid npm audit counts for {repository}:{relative}")
        lock = _require_file(workspace, repository, relative, "npm audit baseline lock")
        actual = hashlib.sha256(lock.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(
                f"npm dependency graph changed for {repository}:{relative}; expected audit "
                f"baseline {expected}, found {actual}. Review npm audit and update the "
                "digest and severity counts before starting a train")
        if baseline.get("strictInstallScripts", False):
            manifest = lock.with_name("package.json")
            if not manifest.is_file():
                raise RuntimeError(
                    f"strict install-script manifest is missing for {repository}:{relative}")
            npm_policy = _captured_npm_policy(workspace)
            identity = f"{repository}:{lock.relative_to(workspace / repository)}"
            try:
                pending = npm_policy.unreviewed_install_scripts(
                    load_config(manifest), load_config(lock), identity)
            except ValueError as error:
                raise RuntimeError(str(error)) from error
            if pending:
                raise RuntimeError(
                    f"unreviewed npm install scripts in {repository}:{relative}: "
                    + ", ".join(sorted(pending)))
    return len(baselines)


def validate_configuration(
    build: dict, frontend: dict, docker: dict, workspace: Path,
    expected_source_version: str | None = None,
) -> dict:
    """Validate every cross-file train contract against the captured source tree."""
    repositories = _unique_strings(build.get("repositories"), "build repositories")
    if build.get("organization") != "metadatacenter" or build.get("sourceBranch") != "develop":
        raise RuntimeError("build train source must be metadatacenter/develop")
    maven = _unique_strings(build.get("mavenRepositories"), "Maven repositories")
    if not set(maven).issubset(repositories):
        raise RuntimeError("Maven repositories must be part of the source repository set")
    phases = build.get("phases")
    if not isinstance(phases, list) or not phases:
        raise RuntimeError("build train must declare Maven phases")
    phase_names = []
    for phase in phases:
        if not isinstance(phase, dict):
            raise RuntimeError(f"invalid Maven phase: {phase!r}")
        name = phase.get("name")
        repository = phase.get("repository")
        if not isinstance(name, str) or not name or repository not in maven:
            raise RuntimeError(f"invalid Maven phase: {phase!r}")
        phase_names.append(name)
        wrapper = workspace / repository / "mvnw"
        if not wrapper.is_file() or not os.access(wrapper, os.X_OK):
            raise RuntimeError(f"Maven wrapper is missing or not executable: {wrapper}")
    if len(phase_names) != len(set(phase_names)):
        raise RuntimeError("Maven phase names must be unique")
    _unique_strings(build.get("requiredArtifacts"), "required Maven artifacts")

    model = frontend.get("model", {})
    cee = frontend.get("cee", {})
    model_repository = model.get("repository")
    cee_repository = cee.get("repository")
    if (
        model_repository not in repositories or cee_repository not in repositories
        or model_repository == cee_repository
    ):
        raise RuntimeError("frontend train must declare distinct captured model and CEE repositories")
    for field in ("sourceManifest", "publishedManifest"):
        _require_file(workspace, model_repository, model.get(field), f"model {field}")
    for field in ("sourceManifest", "sourceLock"):
        _require_file(workspace, cee_repository, cee.get(field), f"CEE {field}")
    for consumer in cee.get("additionalModelConsumers", []):
        _require_file(workspace, cee_repository, consumer.get("manifest"), "CEE model manifest")
        _require_file(workspace, cee_repository, consumer.get("lock"), "CEE model lock")

    frontends = frontend.get("frontends")
    if not isinstance(frontends, list) or not frontends:
        raise RuntimeError("frontend train must declare published frontends")
    for key in ("id", "image", "npmVersionVariable"):
        values = [item.get(key) for item in frontends if isinstance(item, dict)]
        if len(values) != len(frontends) or any(not isinstance(item, str) or not item for item in values) \
                or len(values) != len(set(values)):
            raise RuntimeError(f"frontend {key} values must be present and unique")
    for item in frontends:
        repository = item.get("repository")
        if repository not in repositories:
            raise RuntimeError(f"frontend repository is absent from source train: {repository}")
        package_path = _safe_relative(item.get("packagePath"), "frontend packagePath")
        _require_file(workspace, repository, f"{package_path}/package.json", "frontend manifest")
        _require_file(workspace, repository, f"{package_path}/package-lock.json", "frontend lock")
        consumer = item.get("ceeConsumer")
        if consumer is not None:
            if not isinstance(consumer, dict):
                raise RuntimeError(f"invalid CEE consumer for {repository}")
            _require_file(workspace, repository, consumer.get("manifest"), "CEE consumer manifest")
            _require_file(workspace, repository, consumer.get("lock"), "CEE consumer lock")
        prepared = item.get("preparedBuild")
        if prepared is not None:
            directory = workspace / repository / _safe_relative(
                prepared.get("directory"), "prepared build directory")
            if not directory.is_dir():
                raise RuntimeError(f"prepared build directory is missing: {directory}")
            commands = prepared.get("commands")
            if not isinstance(commands, list) or not commands or not all(
                isinstance(command, list) and command and all(
                    isinstance(part, str) and part for part in command)
                for command in commands
            ):
                raise RuntimeError(f"invalid prepared build commands for {repository}")
            _safe_relative(prepared.get("output"), "prepared build output")
    for consumer in frontend.get("additionalCeeConsumers", []):
        repository = consumer.get("repository")
        if repository not in repositories:
            raise RuntimeError(f"additional CEE consumer is absent from source train: {repository}")
        _require_file(workspace, repository, consumer.get("manifest"), "CEE consumer manifest")
        _require_file(workspace, repository, consumer.get("lock"), "CEE consumer lock")

    audit_baselines = validate_audit_baselines(frontend, workspace, repositories)

    docker_manifest = workspace / "cedar-docker-build" / "bin" / "cedar-images-base.sh"
    docker_text = docker_manifest.read_text(encoding="utf-8")
    if expected_source_version is not None:
        for variable in (
            "IMAGE_VERSION", "CEDAR_MAVEN_VERSION", "CEDAR_APPLICATION_VERSION",
        ):
            match = re.search(rf"^export {variable}=(\S+)$", docker_text, re.MULTILINE)
            actual = match.group(1) if match else None
            if actual != expected_source_version:
                raise RuntimeError(
                    f"Docker {variable} is {actual!r}, expected source version "
                    f"{expected_source_version!r}")
    docker_inputs = frontend_inputs(workspace)
    required_inputs = {item["npmVersionVariable"] for item in frontends}
    required_inputs.add(frontend.get("dockerCeeVersionVariable"))
    required_inputs.update(item.get("versionVariable") for item in frontend.get("runtimePackages", []))
    invalid_inputs = sorted(item for item in required_inputs if not isinstance(item, str) or not item)
    missing_inputs = sorted(set(required_inputs) - set(docker_inputs)) if not invalid_inputs else []
    if invalid_inputs or missing_inputs:
        raise RuntimeError(
            f"Docker npm inputs are invalid or missing: invalid={invalid_inputs}, missing={missing_inputs}")

    groups = docker.get("groups")
    if not isinstance(groups, dict):
        raise RuntimeError("Docker train has no image groups")
    ordered = []
    for group in ("javaBase", "microserviceBase", "infrastructure", "microservices", "frontends"):
        images = _unique_strings(groups.get(group), f"Docker {group} images")
        ordered.extend(images)
    if len(ordered) != 31 or len(ordered) != len(set(ordered)):
        raise RuntimeError(f"Docker train must contain 31 unique core images, found {len(set(ordered))}")
    configured_frontends = {item["image"] for item in frontends}
    if configured_frontends != set(groups["frontends"]):
        raise RuntimeError("frontend and Docker train image sets differ")
    docker_root = workspace / "cedar-docker-build"
    missing_images = sorted(image for image in ordered if not (docker_root / image).is_dir())
    if missing_images:
        raise RuntimeError("Docker build directories are missing: " + ", ".join(missing_images))
    return {
        "repositories": len(repositories),
        "mavenRepositories": len(maven),
        "frontends": len(frontends),
        "images": len(ordered),
        "auditBaselines": audit_baselines,
    }


def validate_train(version: str) -> str:
    if not TRAIN_RE.fullmatch(version):
        raise ValueError(
            f"invalid train version {version!r}; expected 2.9.3-dev.YYYYMMDD.HHMM"
        )
    return version


def train_key(version: str) -> tuple[int, int, int, str, str]:
    validate_train(version)
    base, timestamp = version.split("-dev.", 1)
    major, minor, patch = (int(part) for part in base.split("."))
    day, minute = timestamp.split(".", 1)
    return major, minor, patch, day, minute


def train_output_timestamp(version: str) -> str:
    validate_train(version)
    timestamp = version.split("-dev.", 1)[1]
    parsed = dt.datetime.strptime(timestamp, "%Y%m%d.%H%M").replace(tzinfo=dt.timezone.utc)
    return parsed.isoformat().replace("+00:00", "Z")


def resolve_sha(organization: str, repository: str, branch: str) -> tuple[str, str]:
    url = f"https://github.com/{organization}/{repository}.git"
    output = run(["git", "ls-remote", url, f"refs/heads/{branch}"], capture=True)
    if not output:
        raise RuntimeError(f"{repository} has no {branch} branch")
    return repository, output.split()[0]


def capture_shas(config: dict) -> dict[str, str]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                resolve_sha,
                config["organization"],
                repository,
                config["sourceBranch"],
            )
            for repository in config["repositories"]
        ]
        return dict(sorted(future.result() for future in futures))


def checkout_one(organization: str, repository: str, sha: str, workspace: Path) -> None:
    target = workspace / repository
    if target.exists():
        raise RuntimeError(f"checkout target already exists: {target}")
    target.mkdir(parents=True)
    run(["git", "init", "--quiet"], cwd=target)
    run(["git", "remote", "add", "origin", f"https://github.com/{organization}/{repository}.git"], cwd=target)
    run(["git", "fetch", "--quiet", "--depth", "1", "origin", sha], cwd=target)
    run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd=target)


def checkout_all(config: dict, repositories: dict[str, str], workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    if any(workspace.iterdir()):
        raise RuntimeError(f"train workspace is not empty: {workspace}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                checkout_one,
                config["organization"],
                repository,
                sha,
                workspace,
            )
            for repository, sha in repositories.items()
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()


def direct_child(element: ET.Element, name: str) -> ET.Element | None:
    return element.find(f"{{{MAVEN_NS}}}{name}")


def direct_text(element: ET.Element, name: str) -> str | None:
    child = direct_child(element, name)
    return child.text.strip() if child is not None and child.text else None


def pom_version(pom: Path) -> str:
    root = ET.parse(pom).getroot()
    version = direct_text(root, "version")
    if version:
        return version
    parent = direct_child(root, "parent")
    if parent is not None:
        version = direct_text(parent, "version")
    if not version:
        raise RuntimeError(f"cannot determine Maven version from {pom}")
    return version


def stamp_pom(pom: Path, source: str, target: str) -> bool:
    ET.register_namespace("", MAVEN_NS)
    tree = ET.parse(pom)
    root = tree.getroot()
    changed = False

    own_version = direct_child(root, "version")
    if own_version is not None and own_version.text and own_version.text.strip() == source:
        own_version.text = target
        changed = True

    parent = direct_child(root, "parent")
    if parent is not None and direct_text(parent, "groupId") == "org.metadatacenter":
        parent_version = direct_child(parent, "version")
        if parent_version is not None and parent_version.text and parent_version.text.strip() == source:
            parent_version.text = target
            changed = True

    properties = direct_child(root, "properties")
    if properties is not None:
        cedar_version = direct_child(properties, "cedar.version")
        if cedar_version is not None and cedar_version.text and cedar_version.text.strip() == source:
            cedar_version.text = target
            changed = True

    for tag in ("dependency", "plugin", "extension"):
        for item in root.iter(f"{{{MAVEN_NS}}}{tag}"):
            if direct_text(item, "groupId") != "org.metadatacenter":
                continue
            item_version = direct_child(item, "version")
            if item_version is not None and item_version.text and item_version.text.strip() == source:
                item_version.text = target
                changed = True

    if changed:
        tree.write(pom, encoding="utf-8", xml_declaration=True)
    return changed


def stamp_workspace(config: dict, workspace: Path, source: str, target: str) -> int:
    changed = 0
    for pom in maven_poms(config, workspace):
        changed += int(stamp_pom(pom, source, target))
    if not changed:
        raise RuntimeError(f"no POM contained source version {source}")
    return changed


def maven_poms(config: dict, workspace: Path) -> list[Path]:
    poms: list[Path] = []
    for repository in config["mavenRepositories"]:
        for pom in (workspace / repository).rglob("pom.xml"):
            if any(part in {"target", ".git"} for part in pom.parts):
                continue
            poms.append(pom)
    return sorted(poms)


def assert_no_snapshot_poms(config: dict, workspace: Path) -> None:
    snapshots = [
        pom.relative_to(workspace).as_posix()
        for pom in maven_poms(config, workspace)
        if "-SNAPSHOT" in pom.read_text(encoding="utf-8")
    ]
    if snapshots:
        preview = ", ".join(snapshots[:10])
        remainder = f" (and {len(snapshots) - 10} more)" if len(snapshots) > 10 else ""
        raise RuntimeError(
            "stamped train workspace still contains -SNAPSHOT in: " + preview + remainder
        )


def assert_no_local_maven_snapshots(local_repository: Path) -> None:
    group_root = local_repository / "org" / "metadatacenter"
    snapshots = sorted(
        path.relative_to(local_repository).as_posix()
        for path in group_root.rglob("*")
        if path.is_dir() and path.name.endswith("-SNAPSHOT")
    ) if group_root.exists() else []
    if snapshots:
        preview = ", ".join(snapshots[:10])
        remainder = f" (and {len(snapshots) - 10} more)" if len(snapshots) > 10 else ""
        raise RuntimeError(
            "job-local Maven repository contains org.metadatacenter snapshot paths: "
            + preview + remainder
        )


def frontend_inputs(workspace: Path) -> dict[str, str]:
    manifest = workspace / "cedar-docker-build" / "bin" / "cedar-images-base.sh"
    return dict(sorted(NPM_INPUT_RE.findall(manifest.read_text(encoding="utf-8"))))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def prepare(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.resume or args.version)
    manifest_path = args.state / "trains" / f"{version}.json"
    completed_path = args.state / "completed" / f"{version}.json"
    if args.resume:
        if not manifest_path.exists():
            raise RuntimeError(f"train {version} has no recorded source manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        repositories = manifest["repositories"]
    else:
        if manifest_path.exists():
            raise RuntimeError(f"train {version} already exists; use --resume {version}")
        repositories = capture_shas(config)

    checkout_all(config, repositories, args.workspace)
    source_version = pom_version(args.workspace / "cedar-parent" / "pom.xml")
    if source_version.endswith("-SNAPSHOT") is False:
        raise RuntimeError(f"cedar-parent develop version is not a snapshot: {source_version}")

    if not args.resume:
        manifest = {
            "schemaVersion": 2,
            "version": version,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "sourceBranch": config["sourceBranch"],
            "sourceVersion": source_version,
            "mavenRepository": config["mavenRepository"],
            "repositories": repositories,
            # These are compatibility defaults from cedar-docker-build. The npm train replaces
            # every CEDAR package pin with versions derived from its captured source commits.
            "frontendPackages": frontend_inputs(args.workspace),
        }
        write_json(manifest_path, manifest)

    stamp_workspace(config, args.workspace, manifest["sourceVersion"], version)
    assert_no_snapshot_poms(config, args.workspace)
    print(f"Prepared {version} from {len(repositories)} exact repository commits.")


def _http_failure(label: str, error: urllib.error.HTTPError) -> RuntimeError:
    """Translate transport-shaped failures into an operator decision."""
    if error.code == 401:
        detail = "credentials were rejected"
    elif error.code == 403:
        detail = "the authenticated account is not allowed to read this endpoint"
    elif error.code == 404:
        detail = "the expected endpoint is absent; the repository or probe contract has changed"
    elif error.code == 429:
        detail = "Nexus is rate limiting requests"
    elif error.code >= 500:
        detail = "Nexus is unavailable or unhealthy"
    else:
        detail = "the endpoint rejected the read-only probe"
    return RuntimeError(f"{label} failed: {detail} (HTTP {error.code})")


def _request(
    request: urllib.request.Request,
    label: str,
    opener=None,
    allow_unauthorized: bool = False,
):
    opener = opener or urllib.request.urlopen
    try:
        return opener(request, timeout=60)
    except urllib.error.HTTPError as error:
        if allow_unauthorized and error.code == 401:
            return error
        failure = _http_failure(label, error)
        error.close()
        raise failure from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RuntimeError(f"{label} failed: cannot reach Nexus ({error})") from error


def _authenticated_request(
    url: str,
    username: str,
    password: str,
    label: str = "Nexus authentication",
    opener=None,
) -> bytes:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {token}"})
    with _request(request, label, opener=opener) as response:
        return response.read()


def _docker_registry_preflight(username: str, password: str, opener=None) -> None:
    """Authenticate to the Docker Registry v2 API without changing Docker config."""
    basic = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(
        NEXUS_DOCKER_V2, headers={"Authorization": f"Basic {basic}"})
    response = _request(
        request, "Docker registry authentication", opener=opener, allow_unauthorized=True)
    if getattr(response, "status", None) != 401:
        with response:
            response.read()
        return

    challenge = response.headers.get("WWW-Authenticate", "")
    response.close()
    match = re.match(r'^Bearer\s+(.+)$', challenge, re.IGNORECASE)
    if not match:
        raise RuntimeError(
            "Docker registry authentication failed: Nexus returned no Bearer challenge")
    parameters = dict(re.findall(r'(\w+)="([^"]*)"', match.group(1)))
    realm = parameters.get("realm")
    if not realm or not realm.startswith(f"{NEXUS_HOST}/"):
        raise RuntimeError(
            "Docker registry authentication failed: Nexus returned an invalid token endpoint")
    query = {
        key: value for key, value in parameters.items()
        if key in {"service", "scope"} and value
    }
    token_url = realm + ("?" + urllib.parse.urlencode(query) if query else "")
    token_body = _authenticated_request(
        token_url, username, password, "Docker registry token", opener=opener)
    try:
        token_payload = json.loads(token_body)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker registry token failed: Nexus returned invalid JSON") from error
    bearer = token_payload.get("token") or token_payload.get("access_token")
    if not isinstance(bearer, str) or not bearer:
        raise RuntimeError("Docker registry token failed: Nexus returned no access token")
    authenticated = urllib.request.Request(
        NEXUS_DOCKER_V2, headers={"Authorization": f"Bearer {bearer}"})
    with _request(authenticated, "Docker registry authentication", opener=opener) as response:
        response.read()


def publication_target_preflight(environment=None, opener=None) -> None:
    """Read every publication surface; never upload, log in, or alter client config."""
    environment = os.environ if environment is None else environment
    username = environment.get("BMIR_NEXUS_USERNAME")
    password = environment.get("BMIR_NEXUS_PASSWORD")
    if not username or not password:
        raise RuntimeError("BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD are required")

    probes = (
        ("Nexus service status", f"{NEXUS_HOST}/service/rest/v1/status/check"),
        ("Nexus writable status", f"{NEXUS_HOST}/service/rest/v1/status/writable"),
        # cedar-maven-dev has a Release version policy, so artifact-level
        # maven-metadata.xml is expected to be absent. Its repository root is the contract.
        ("Maven train repository root", NEXUS_MAVEN_TRAIN_REPOSITORY),
    )
    for label, url in probes:
        _authenticated_request(url, username, password, label, opener=opener)
        print(f"OK {label}")

    npm_body = _authenticated_request(
        f"{NEXUS_NPM_REPOSITORY}-/whoami",
        username,
        password,
        "npm registry authentication",
        opener=opener,
    )
    try:
        npm_identity = json.loads(npm_body).get("username")
    except (AttributeError, json.JSONDecodeError) as error:
        raise RuntimeError("npm registry authentication failed: Nexus returned invalid JSON") from error
    if not isinstance(npm_identity, str) or not npm_identity:
        raise RuntimeError("npm registry authentication failed: Nexus returned no username")
    print(f"OK npm registry authentication ({npm_identity})")

    _docker_registry_preflight(username, password, opener=opener)
    print("OK Docker registry authentication")


def _captured_ci_policy(workspace: Path):
    path = workspace / "cedar-cli" / "org" / "metadatacenter" / "github_ci.py"
    if not path.is_file():
        raise RuntimeError(f"captured GitHub CI probe policy is missing: {path}")
    name = "cedar_train_captured_github_ci"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load captured GitHub CI probe policy: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _captured_npm_policy(workspace: Path):
    path = workspace / "cedar-cli" / "org" / "metadatacenter" / "npm_policy.py"
    if not path.is_file():
        raise RuntimeError(f"captured npm install policy is missing: {path}")
    name = "cedar_train_captured_npm_policy"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load captured npm install policy: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _github_ci_preflight(source: dict, workspace: Path, policy=None) -> None:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GH_TOKEN is required for exact-source CI preflight")
    policy = policy or _captured_ci_policy(workspace)
    failures = []
    for repository, revision in sorted(source.get("repositories", {}).items()):
        workflow_root = workspace / repository / ".github" / "workflows"
        if not workflow_root.is_dir() or not any(path.is_file() for path in workflow_root.iterdir()):
            print(f"CI advisory: {repository} has no workflow contract; train gates its outputs.")
            continue
        try:
            probe = policy.probe_exact_commit(
                repository,
                revision,
                reporter=lambda message: print(f"CI retry: {message}", flush=True),
            )
        except policy.GithubCIProbeError as error:
            failures.append(str(error))
            continue
        runs = list(probe.runs)
        # The train workflow is the caller currently performing this check. Counting it would
        # make cedar-development wait on itself forever (or inherit a previous train failure).
        if repository == "cedar-development":
            runs = [
                run_record for run_record in runs
                if run_record.get("path") != ".github/workflows/build-train.yml"
            ]
            if not runs:
                print(
                    "CI advisory: cedar-development has no separate source-validation run; "
                    "the train controller is executing its captured code now.")
                continue
        if not runs:
            failures.append(
                f"{repository}: no CI run for {revision[:8]} after bounded indexing grace")
            continue
        for name, run_record in policy.latest_runs_by_name(runs).items():
            status = run_record.get("status")
            conclusion = run_record.get("conclusion")
            url = policy.run_url(run_record)
            suffix = f" ({url})" if url else ""
            if status != "completed":
                failures.append(f"{repository}: {name} is {status or 'pending'}{suffix}")
            elif conclusion not in policy.GREEN_CONCLUSIONS:
                failures.append(
                    f"{repository}: {name} concluded "
                    f"{conclusion or 'without a result'}{suffix}")
    if failures:
        raise RuntimeError("train source CI is not settled: " + "; ".join(failures))


def publication_preflight(args: argparse.Namespace) -> None:
    version = validate_train(args.version)
    source_path = args.state / "trains" / f"{version}.json"
    if not source_path.is_file():
        raise RuntimeError(f"train {version} has no captured source manifest")
    source = load_config(source_path)
    summary = validate_configuration(
        load_config(args.config),
        load_config(args.frontend_config),
        load_config(args.docker_config),
        args.workspace,
        source.get("sourceVersion"),
    )
    _github_ci_preflight(source, args.workspace)

    publication_target_preflight()
    print(
        "Train preflight passed: "
        f"{summary['repositories']} repositories, {summary['mavenRepositories']} Maven, "
        f"{summary['frontends']} frontends, {summary['images']} Docker images, "
        f"{summary['auditBaselines']} reviewed npm lock baselines; "
        "source CI and all publication credentials are settled."
    )


def local_configuration_preflight(args: argparse.Namespace) -> None:
    actual_source_version = pom_version(args.workspace / "cedar-parent" / "pom.xml")
    expected_source_version = getattr(args, "expected_source_version", None)
    if expected_source_version is not None and actual_source_version != expected_source_version:
        raise RuntimeError(
            f"cedar-parent version is {actual_source_version!r}, expected "
            f"{expected_source_version!r}"
        )
    source_version = expected_source_version or actual_source_version
    summary = validate_configuration(
        load_config(args.config),
        load_config(args.frontend_config),
        load_config(args.docker_config),
        args.workspace,
        source_version,
    )
    print(
        "Local train configuration passed: "
        f"{summary['repositories']} repositories, {summary['frontends']} frontends, "
        f"{summary['images']} Docker images, "
        f"{summary['auditBaselines']} reviewed npm lock baselines."
    )


def build(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.version)
    local_repository = args.workspace / ".m2" / "repository"
    local_repository.mkdir(parents=True, exist_ok=True)
    for phase in config["phases"]:
        repository = args.workspace / phase["repository"]
        wrapper = repository / "mvnw"
        command = [
            str(wrapper),
            "--batch-mode",
            "--no-transfer-progress",
            "--settings",
            str(args.settings),
            f"-Dmaven.repo.local={local_repository}",
            f"-Dproject.build.outputTimestamp={train_output_timestamp(version)}",
            "clean",
            "install",
            "-DskipTests",
        ]
        print(f"\n=== {phase['name']}: {phase['repository']} ({version}) ===", flush=True)
        run(command, cwd=repository)
    assert_no_local_maven_snapshots(local_repository)
    publish_local_repository(
        local_repository, config["mavenRepository"], version, resuming=args.resume,
    )


# Nexus answers a transient fault with one of these rather than a refused connection, and a
# train uploads a few hundred files, so without a retry one blip anywhere in the run discards
# the whole build. None of them says anything about the artifact being uploaded.
TRANSIENT_STATUSES = frozenset({429, 500, 502, 503, 504})
# Nexus does not fail one request in isolation: it goes unavailable for a burst and then
# recovers, so the budget is sized to outlast a burst rather than to survive a single blip.
# Eight attempts with the backoff below span about three minutes, which is cheap against a
# train that runs for twenty-five and is discarded whole if the burst outlasts the retries.
UPLOAD_ATTEMPTS = 8
MAX_RETRY_DELAY = 60
THROTTLED_RETRY_DELAY = 120


def with_retries(what: str, attempt_call):
    """Run a Nexus call, retrying only the failures that carry no verdict about the content."""
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        throttled_for = None
        try:
            return attempt_call()
        except urllib.error.HTTPError as error:
            if error.code not in TRANSIENT_STATUSES or attempt == UPLOAD_ATTEMPTS:
                raise
            reason = f"HTTP {error.code}"
            # A registry over its request budget answers 429, or 500 on every repository path
            # while its status endpoints stay green. Retrying such a fault at the pace of a
            # dropped connection spends the very budget that is exhausted, so wait for as long
            # as the server asks, and otherwise for the longest wait allowed.
            after = error.headers.get("Retry-After") if error.headers else None
            if after and after.strip().isdigit():
                throttled_for = min(THROTTLED_RETRY_DELAY, int(after.strip()))
            elif error.code == 429:
                throttled_for = THROTTLED_RETRY_DELAY
            error.close()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            if attempt == UPLOAD_ATTEMPTS:
                raise
            reason = str(error)
        delay = throttled_for if throttled_for is not None else min(MAX_RETRY_DELAY, 2 ** attempt)
        print(f"retry {attempt}/{UPLOAD_ATTEMPTS - 1} after {reason}: {what} (waiting {delay}s)",
              flush=True)
        time.sleep(delay)


def remote_bytes(url: str) -> bytes | None:
    def read():
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                body = response.read()
                # A degraded registry can close a connection mid-body and leave a short read
                # looking like a successful one. Comparing that against the bytes going up
                # reports an immutable path as holding different content, which is a far more
                # alarming thing to be told than the truth, so a short read is a failed read.
                declared = response.headers.get("Content-Length")
                if declared is not None and declared.isdigit() and len(body) != int(declared):
                    raise urllib.error.URLError(
                        f"truncated read: {len(body)} of {declared} bytes from {url}")
                return body
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
    return with_retries(f"read {url}", read)


def remote_sha1(url: str) -> str | None:
    """Read the checksum Nexus stores beside an artifact, rather than the artifact.

    The immutability guard only needs to know whether the bytes already there are the bytes
    going up. Answering that by downloading the artifact costs its whole size, and the
    largest of them are over 130 MB, so it is answered from the sidecar Nexus writes next
    to every file instead.

    A missing sidecar therefore reads as a free path. That holds because Nexus stores the
    checksum for a hosted Maven repository as part of accepting the artifact, so the two are
    present or absent together; a request that fails rather than returning 404 is retried by
    remote_bytes and raises instead of arriving here as None.
    """
    digest = remote_bytes(url + ".sha1")
    if digest is None:
        return None
    text = digest.decode("utf-8", "replace").strip().split()
    return text[0].lower() if text else None


def upload_file(
    source: Path,
    destination: str,
    username: str,
    password: str,
    check_existing: bool = True,
) -> str:
    content = source.read_bytes()
    if check_existing:
        existing = remote_sha1(destination)
        if existing is not None:
            if existing != hashlib.sha1(content).hexdigest():
                raise RuntimeError(f"immutable Nexus path contains different bytes: {destination}")
            return "unchanged"
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(
        destination,
        data=content,
        method="PUT",
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/octet-stream",
        },
    )
    def put():
        with urllib.request.urlopen(request, timeout=300) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError(f"Nexus returned HTTP {response.status} for {destination}")
    with_retries(f"upload {destination}", put)
    return "uploaded"


def publish_local_repository(
    local_repository: Path,
    repository_url: str,
    version: str,
    resuming: bool = True,
) -> None:
    username = os.environ.get("BMIR_NEXUS_USERNAME")
    password = os.environ.get("BMIR_NEXUS_PASSWORD")
    if not username or not password:
        raise RuntimeError("BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD are required")
    group_root = local_repository / "org" / "metadatacenter"
    candidates = sorted(
        path for path in group_root.rglob("*")
        if path.is_file()
        and path.parent.name == version
        and not path.name.startswith(".")
        and path.name != "_remote.repositories"
        and not path.name.endswith((".lastUpdated", ".sha1", ".md5", ".sha256", ".sha512"))
        and not path.name.startswith("maven-metadata")
    )
    if not candidates:
        raise RuntimeError(f"the local Maven repository contains no files for {version}")
    # A train ID is confirmed unused before a new train is dispatched, so on a fresh build
    # nothing can be at these paths and asking about each one costs a request per file to
    # learn what was already established. A resume asks, because a resume exists precisely
    # because some of them are already there.
    if not resuming:
        print(f"Fresh train {version}: uploading {len(candidates)} files without existence checks.",
              flush=True)
    counts = {"uploaded": 0, "unchanged": 0}
    for source in candidates:
        relative = source.relative_to(local_repository).as_posix()
        result = upload_file(
            source, repository_url.rstrip("/") + "/" + relative, username, password,
            check_existing=resuming,
        )
        counts[result] += 1
        print(f"{result:9} {relative}", flush=True)
    print(
        f"Published {counts['uploaded']} new files; verified {counts['unchanged']} existing files.",
        flush=True,
    )


def nexus_artifacts(repository_url: str, version: str) -> set[str]:
    base = repository_url.split("/repository/", 1)[0]
    repository = repository_url.rstrip("/").rsplit("/", 1)[-1]
    continuation = None
    artifacts: set[str] = set()
    while True:
        query = {"repository": repository, "version": version}
        if continuation:
            query["continuationToken"] = continuation
        url = f"{base}/service/rest/v1/search?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.load(response)
        artifacts.update(item["name"] for item in payload.get("items", []))
        continuation = payload.get("continuationToken")
        if not continuation:
            return artifacts


def complete(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.version)
    manifest_path = args.state / "trains" / f"{version}.json"
    if not manifest_path.exists():
        raise RuntimeError(f"train {version} has no source manifest")
    published = set()
    missing = list(config["requiredArtifacts"])
    for attempt in range(12):
        published = nexus_artifacts(config["mavenRepository"], version)
        missing = sorted(set(config["requiredArtifacts"]) - published)
        if not missing:
            break
        if attempt < 11:
            print("Waiting for Nexus search indexing: " + ", ".join(missing), flush=True)
            time.sleep(10)
    if missing:
        raise RuntimeError("Nexus is missing required train artifacts: " + ", ".join(missing))
    completed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    completion = {
        "schemaVersion": 1,
        "version": version,
        "completedAt": completed_at,
        "manifest": f"trains/{version}.json",
        "verifiedArtifacts": sorted(published),
    }
    write_json(args.state / "completed" / f"{version}.json", completion)
    current_path = args.state / "current.json"
    current = json.loads(current_path.read_text(encoding="utf-8")) if current_path.exists() else None
    if current is None or train_key(version) > train_key(current["version"]):
        write_json(current_path, {
            "schemaVersion": 1,
            "version": version,
            "completedAt": completed_at,
            "manifest": f"trains/{version}.json",
            "completion": f"completed/{version}.json",
        })
    else:
        print(
            f"Completed {version}, but kept newer current train {current['version']}.",
            flush=True,
        )
    print(f"Train {version} is complete with {len(published)} Maven artifacts.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    commands = result.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare")
    selector = prepare_parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--version")
    selector.add_argument("--resume")
    prepare_parser.add_argument("--workspace", type=Path, required=True)
    prepare_parser.add_argument("--state", type=Path, required=True)
    prepare_parser.set_defaults(handler=prepare)

    preflight_parser = commands.add_parser("preflight")
    preflight_parser.add_argument("--version", required=True)
    preflight_parser.add_argument("--workspace", type=Path, required=True)
    preflight_parser.add_argument("--state", type=Path, required=True)
    preflight_parser.add_argument("--frontend-config", type=Path, default=DEFAULT_FRONTEND_CONFIG)
    preflight_parser.add_argument("--docker-config", type=Path, default=DEFAULT_DOCKER_CONFIG)
    preflight_parser.set_defaults(handler=publication_preflight)

    local_parser = commands.add_parser(
        "validate-local",
        help="Validate the checked-out train configuration without network access",
    )
    local_parser.add_argument("--workspace", type=Path, required=True)
    local_parser.add_argument("--frontend-config", type=Path, default=DEFAULT_FRONTEND_CONFIG)
    local_parser.add_argument("--docker-config", type=Path, default=DEFAULT_DOCKER_CONFIG)
    local_parser.add_argument("--expected-source-version")
    local_parser.set_defaults(handler=local_configuration_preflight)

    target_parser = commands.add_parser(
        "probe-publication",
        help="Read-only Nexus, npm, and Docker publication-target preflight",
    )
    target_parser.set_defaults(handler=lambda _args: publication_target_preflight())

    build_parser = commands.add_parser("build")
    build_parser.add_argument("--version", required=True)
    build_parser.add_argument("--workspace", type=Path, required=True)
    build_parser.add_argument("--settings", type=Path, default=ROOT / "maven-train-settings.xml")
    build_parser.add_argument(
        "--resume", action="store_true",
        help="Check each destination before uploading, because some may already be there",
    )
    build_parser.set_defaults(handler=build)

    complete_parser = commands.add_parser("complete")
    complete_parser.add_argument("--version", required=True)
    complete_parser.add_argument("--state", type=Path, required=True)
    complete_parser.set_defaults(handler=complete)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (OSError, RuntimeError, ValueError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
