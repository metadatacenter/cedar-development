#!/usr/bin/env python3
"""Validate every artifact a deployment holds, and count the legacy shapes it still carries.

Two questions about a production deployment are answered in one read-only pass. The first is whether
each stored template, element, field and instance passes ``cedar-model-validation-library``, the
arbiter nothing enters production without; an instance is validated against the exact template its
``schema:isBasedOn`` names. The second is how many artifacts carry one of the legacy representations
the backend roadmap's production-data item lists, shapes a valid artifact may still have: an
inherently multiple field deployed as an object, a title that does not follow its name, a zero
standing in for "unbounded" or "unknown", a null annotation identifier, a child missing from
``_ui.order``, an absent or stale model version, a controlled-term constraint that names no source
system, and the identifier and mapping defects an ordinary save would repair. Every artifact is
counted once per condition, and each condition is cross-tabulated against the validation verdict.

Enumeration and fetching are the REST audit's, imported from ``cedar_artifact_rest_audit.py``: the
API key's view of ``/search-deep`` across every version and publication state, then the typed GET
for each artifact. Validation runs in one JVM that ``cedar_validation_bridge.java`` keeps alive for
the whole pass. Results stream as one JSON line per artifact, a summary is checkpointed at every
progress report, and an interrupted run continues with ``--resume``.

    export CEDAR_API_KEY=...
    python3 ops/cedar_artifact_validation_audit.py \\
      --server https://resource.metadatacenter.org \\
      --out production-validation.jsonl

Requires JDK 17 and a built ``cedar-model-validation-library``; ``cedar_validate.sh`` resolves both.
No third-party Python packages are required.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import select
import subprocess
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedar_artifact_rest_audit as rest  # noqa: E402

REFS_FORMAT_VERSION = 1
# Mirrors ModelNodeNames.MODEL_VERSION in cedar-model-library, the version the artifact library
# writes and the disabled comparison in JsonArtifactShapeChecks would compare against.
MODEL_VERSION = "1.6.0"
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
DEFAULT_TYPES = "all"
DEFAULT_PROGRESS_EVERY = 200
DEFAULT_PROGRESS_SECONDS = 60
# The resource server refuses a page larger than its configured maxPageSize, 500 in cedar-main.yml.
DEFAULT_PAGE_SIZE = 500
ENUMERATION_REPORT_SECONDS = 30
DEFAULT_TEMPLATE_CACHE = 500
DEFAULT_FETCH_WORKERS = 4
DEFAULT_BRIDGE_TIMEOUT = 120
DEFAULT_BRIDGE_MAX_RESTARTS = 5
BRIDGE_SOURCE = Path(__file__).with_name("cedar_validation_bridge.java")
VALIDATE_SH = Path(__file__).with_name("cedar_validate.sh")

TEMPLATE = "https://schema.metadatacenter.org/core/Template"
KIND_WORD = {
    TEMPLATE: "template",
    rest.TEMPLATE_ELEMENT: "element",
    rest.TEMPLATE_FIELD: "field",
    rest.STATIC_TEMPLATE_FIELD: "field",
}
CONTAINER_TYPES = {TEMPLATE, rest.TEMPLATE_ELEMENT}
CONSTRAINT_KEYS = ("ontologies", "valueSets", "classes", "branches")
COUNTED_CONSTRAINT_KEYS = {"ontologies", "valueSets"}

# The roadmap paragraph each rule measures. Rules the REST audit contributes are grouped by the
# risk it assigns them, under "minting".
TOPICS = {
    "inherently-multiple-child-object": "object-shaped multiple",
    "title-not-canonical": "title",
    "title-not-canonical-nested": "title",
    "max-items-zero": "zero sentinels",
    "num-terms-zero": "zero sentinels",
    "stray-cardinality-keys": "zero sentinels",
    "annotation-id-null": "null annotation id",
    "annotation-id-null-with-payload": "null annotation id",
    "ui-order-absent": "ui order",
    "ui-order-missing-child": "ui order",
    "ui-order-orphan-entry": "ui order",
    "ui-order-duplicate-entry": "ui order",
    "schema-version-absent": "model version",
    "schema-version-unparsable": "model version",
    "schema-version-stale": "model version",
    "schema-version-nested-absent": "model version",
    "schema-version-nested-stale": "model version",
    "source-system-absent": "terminology source",
}
# The REST audit's diagnostics say the audit could not finish, not that the artifact is defective.
REST_DIAGNOSTIC_RULES = {"template-analysis-unavailable"}

VALIDATION_STATUSES = ("valid", "invalid", "error", "skipped")


@dataclass(frozen=True)
class Condition:
    rule: str
    path: str
    value: Any = None
    risk: Optional[str] = None

    @property
    def topic(self) -> str:
        if self.rule in TOPICS:
            return TOPICS[self.rule]
        return f"minting ({self.risk})" if self.risk else "minting"

    def json_record(self) -> dict[str, Any]:
        record: dict[str, Any] = {"rule": self.rule, "path": self.path or "/"}
        if self.value is not None:
            record["value"] = self.value if is_json_scalar_or_container(self.value) else str(self.value)
        if self.risk is not None:
            record["risk"] = self.risk
        return record


@dataclass
class SchemaNode:
    """One schema definition: the artifact root, or a child declared under a container's properties."""
    path: str
    definition: dict
    declared: Optional[dict] = None
    declared_path: str = ""
    multiple: bool = False

    @property
    def is_root(self) -> bool:
        return self.declared is None


def is_json_scalar_or_container(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool, list, dict))


def utc_now() -> str:
    return rest.utc_now()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------------------------------
# The inventory rules
# --------------------------------------------------------------------------------------------------


def iter_schema_nodes(artifact: Any) -> Iterator[SchemaNode]:
    """The root definition and every nested child definition, depth first, in document order."""
    if not isinstance(artifact, dict):
        return

    def walk(container: dict, path: str) -> Iterator[SchemaNode]:
        for name, child, multiple, error in rest.direct_schema_children(container):
            if error or child is None:
                continue
            declared_path = rest.child_path(path, name)
            actual_path = f"{declared_path}/items" if multiple else declared_path
            declared = container["properties"][name]
            yield SchemaNode(actual_path, child, declared, declared_path, multiple)
            yield from walk(child, actual_path)

    yield SchemaNode("", artifact)
    yield from walk(artifact, "")


def check_titles(nodes: list[SchemaNode]) -> Iterator[Condition]:
    """A JSON Schema title is derived from the name as "<name> <kind> schema"; report every divergence.

    The server rewrites only the artifact's own title on a write, and an embedded child keeps the
    title its generator gave it, so the root and nested cases are counted apart. The legacy Template
    Designer lower-cased the name it composed the title from, so the value says whether the stored
    title differs from the canonical one in letter case alone.
    """
    for node in nodes:
        definition = node.definition
        kind = KIND_WORD.get(definition.get("@type"))
        name = definition.get("schema:name")
        if kind is None or not isinstance(name, str) or not name.strip():
            continue
        title = definition.get("title")
        expected = f"{name} {kind} schema"
        if title != expected:
            rule = "title-not-canonical" if node.is_root else "title-not-canonical-nested"
            case_only = isinstance(title, str) and title.casefold() == expected.casefold()
            yield Condition(rule, f"{node.path}/title", {"title": title, "caseOnly": case_only})


def is_plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def check_cardinality(nodes: list[SchemaNode]) -> Iterator[Condition]:
    """Zero as "unbounded" on an array deployment, and cardinality keys on an object deployment."""
    for node in nodes:
        if node.is_root or node.declared is None:
            continue
        declared = node.declared
        if node.multiple:
            if is_plain_int(declared.get("maxItems")) and declared["maxItems"] == 0:
                yield Condition("max-items-zero", f"{node.declared_path}/maxItems", 0)
        else:
            stray = {key: declared[key] for key in ("minItems", "maxItems") if key in declared}
            if stray:
                yield Condition("stray-cardinality-keys", node.declared_path, stray)


def check_value_constraints(nodes: list[SchemaNode]) -> Iterator[Condition]:
    """An unknown term count written as zero, and a constraint that names no source system."""
    for node in nodes:
        constraints = node.definition.get("_valueConstraints")
        if not isinstance(constraints, dict):
            continue
        base = f"{node.path}/_valueConstraints"
        for key in CONSTRAINT_KEYS:
            entries = constraints.get(key)
            if not isinstance(entries, list):
                continue
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    continue
                entry_path = f"{base}/{key}/{index}"
                if key in COUNTED_CONSTRAINT_KEYS and is_plain_int(entry.get("numTerms")) \
                        and entry["numTerms"] == 0:
                    yield Condition("num-terms-zero", f"{entry_path}/numTerms", 0)
                if "sourceSystem" not in entry:
                    label = entry.get("acronym") or entry.get("vsCollection") or entry.get("source") \
                        or entry.get("uri")
                    yield Condition("source-system-absent", entry_path, label)


def check_annotations(artifact: Any) -> Iterator[Condition]:
    """An annotation whose identifier is an explicit null, anywhere in the document.

    An entry whose only payload is the null identifier can be removed; one carrying anything else
    is reported apart, for a person to look at.
    """

    def walk(node: Any, path: str) -> Iterator[Condition]:
        if isinstance(node, dict):
            annotations = node.get("_annotations")
            if isinstance(annotations, dict):
                for term, payload in annotations.items():
                    if isinstance(payload, dict) and "@id" in payload and payload["@id"] is None:
                        rule = "annotation-id-null" if set(payload) == {"@id"} \
                            else "annotation-id-null-with-payload"
                        yield Condition(rule, f"{path}/_annotations/{rest.json_pointer_component(term)}/@id",
                                        term)
            for key, value in node.items():
                yield from walk(value, f"{path}/{rest.json_pointer_component(key)}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                yield from walk(value, f"{path}/{index}")

    yield from walk(artifact, "")


def check_ui_order(nodes: list[SchemaNode]) -> Iterator[Condition]:
    """Children declared under properties but missing from _ui.order, and the inverse drift."""
    for node in nodes:
        definition = node.definition
        if definition.get("@type") not in CONTAINER_TYPES:
            continue
        children = [name for name, _child, _multiple, _error in rest.direct_schema_children(definition)]
        ui = definition.get("_ui")
        order_path = f"{node.path}/_ui/order"
        order = ui.get("order") if isinstance(ui, dict) else None
        if not isinstance(order, list):
            if children:
                yield Condition("ui-order-absent", order_path, None)
            continue
        order_names = [entry for entry in order if isinstance(entry, str)]
        declared = set(children)
        for name in children:
            if name not in order_names:
                yield Condition("ui-order-missing-child", order_path, name)
        seen: set[str] = set()
        for name in order_names:
            if name not in declared:
                yield Condition("ui-order-orphan-entry", order_path, name)
            if name in seen:
                yield Condition("ui-order-duplicate-entry", order_path, name)
            seen.add(name)


def check_model_version(nodes: list[SchemaNode]) -> Iterator[Condition]:
    """The model version each schema definition declares, against the version the libraries write."""
    for node in nodes:
        definition = node.definition
        key_path = f"{node.path}/schema:schemaVersion"
        if "schema:schemaVersion" not in definition:
            yield Condition("schema-version-absent" if node.is_root else "schema-version-nested-absent",
                            key_path)
            continue
        version = definition["schema:schemaVersion"]
        if not isinstance(version, str) or not VERSION_PATTERN.match(version):
            if node.is_root:
                yield Condition("schema-version-unparsable", key_path, version)
            else:
                yield Condition("schema-version-nested-stale", key_path, version)
        elif version != MODEL_VERSION:
            yield Condition("schema-version-stale" if node.is_root else "schema-version-nested-stale",
                            key_path, version)


def root_schema_version(artifact: Any) -> Optional[str]:
    if not isinstance(artifact, dict) or "schema:schemaVersion" not in artifact:
        return None
    version = artifact["schema:schemaVersion"]
    return version if isinstance(version, str) else json.dumps(version)


def rest_conditions(ref: rest.ArtifactRef, artifact: Any,
                    shape: Optional[rest.SchemaShape]) -> Iterator[Condition]:
    """The REST audit's rules, as conditions. Its incomplete-audit diagnostics are not conditions."""
    findings = list(rest.audit_common(ref, artifact))
    if ref.artifact_type in {"template", "element"}:
        findings.extend(rest.audit_schema(ref, artifact))
    elif ref.artifact_type == "instance":
        findings.extend(rest.audit_instance(ref, artifact, shape))
    for finding in findings:
        if finding.rule in REST_DIAGNOSTIC_RULES:
            continue
        yield Condition(finding.rule, finding.path, finding.value, finding.risk)


def inventory_conditions(ref: rest.ArtifactRef, artifact: Any,
                         shape: Optional[rest.SchemaShape]) -> list[Condition]:
    conditions: list[Condition] = []
    if isinstance(artifact, dict):
        conditions.extend(check_annotations(artifact))
        if ref.artifact_type != "instance":
            nodes = list(iter_schema_nodes(artifact))
            conditions.extend(check_titles(nodes))
            conditions.extend(check_cardinality(nodes))
            conditions.extend(check_value_constraints(nodes))
            conditions.extend(check_ui_order(nodes))
            conditions.extend(check_model_version(nodes))
    conditions.extend(rest_conditions(ref, artifact, shape))
    return conditions


# --------------------------------------------------------------------------------------------------
# The validation bridge: one JVM, one JSON line per request
# --------------------------------------------------------------------------------------------------


class BridgeError(Exception):
    """The bridge process could not answer."""


class BridgeTimeout(BridgeError):
    """The bridge did not answer within the allowed time; it has been killed."""


class _TimedLineReader:
    """Read newline-terminated records from a pipe with a deadline per record."""

    def __init__(self, descriptor: int):
        self.descriptor = descriptor
        self.buffer = bytearray()

    def readline(self, timeout: float) -> Optional[bytes]:
        deadline = time.monotonic() + timeout
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[:newline])
                del self.buffer[:newline + 1]
                return line
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            ready, _, _ = select.select([self.descriptor], [], [], remaining)
            if not ready:
                raise TimeoutError
            chunk = os.read(self.descriptor, 1 << 16)
            if not chunk:
                return None
            self.buffer += chunk


class ValidationBridge:
    """Drive cedar_validation_bridge.java over its stdin and stdout."""

    def __init__(self, java: str, classpath: str, source: Path, template_cache: int, heap: str,
                 log_path: Path, timeout: float, startup_timeout: float = 180):
        self.command = [java, f"-Xmx{heap}", "-cp", classpath, str(source),
                        "--template-cache", str(template_cache)]
        self.log_path = log_path
        self.timeout = timeout
        self.startup_timeout = startup_timeout
        self.process: Optional[subprocess.Popen] = None
        self.reader: Optional[_TimedLineReader] = None
        self.log = None
        self.seq = 0
        self.starts = 0
        self.hello: dict[str, Any] = {}

    def start(self) -> dict[str, Any]:
        self.kill()
        self.log = open(self.log_path, "a", encoding="utf-8")
        self.log.write(f"--- bridge start {utc_now()}: {' '.join(self.command)}\n")
        self.log.flush()
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, bufsize=0,
        )
        self.reader = _TimedLineReader(self.process.stdout.fileno())
        self.starts += 1
        self.hello = self._exchange({"op": "hello"}, self.startup_timeout)
        if self.hello.get("status") != "ok":
            raise BridgeError(f"bridge refused to start: {self.hello}")
        return self.hello

    def _exchange(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        if self.process is None or self.reader is None or self.process.stdin is None:
            raise BridgeError("bridge is not running")
        self.seq += 1
        payload["seq"] = self.seq
        data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("ascii")
        try:
            self.process.stdin.write(data)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise BridgeError(f"bridge closed its input: {error}") from None
        line = self.reader.readline(timeout)
        if line is None:
            code = self.process.poll()
            raise BridgeError(f"bridge exited with status {code}; see {self.log_path}")
        try:
            answer = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BridgeError(f"bridge answer is not JSON: {error}") from None
        if not isinstance(answer, dict) or answer.get("seq") != self.seq:
            raise BridgeError(f"bridge answered out of sequence: expected seq {self.seq}")
        return answer

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Send one request. A failure kills the process; the caller decides whether to restart."""
        try:
            return self._exchange(payload, self.timeout)
        except TimeoutError:
            self.kill()
            raise BridgeTimeout(f"bridge gave no answer within {self.timeout:.0f}s") from None
        except BridgeError:
            self.kill()
            raise

    def cache_template(self, template_id: str, template: dict) -> dict[str, Any]:
        return self.request({"op": "cache-template", "id": template_id, "template": template})

    def validate(self, kind: str, artifact: Any, template_id: Optional[str] = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"op": "validate", "kind": kind, "artifact": artifact}
        if template_id is not None:
            payload["templateId"] = template_id
        return self.request(payload)

    def kill(self) -> None:
        process, self.process, self.reader = self.process, None, None
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        for stream in (getattr(process, "stdin", None), getattr(process, "stdout", None)):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        if self.log is not None:
            self.log.close()
            self.log = None

    def close(self) -> None:
        if self.process is not None and self.process.poll() is None:
            try:
                self._exchange({"op": "shutdown"}, 10)
                self.process.wait(timeout=10)
            except (BridgeError, TimeoutError, subprocess.TimeoutExpired, OSError):
                pass
        self.kill()


def run_validate_sh(subcommand: str, timeout: float) -> str:
    completed = subprocess.run(
        ["bash", str(VALIDATE_SH), subcommand], capture_output=True, text=True, timeout=timeout,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"cedar_validate.sh {subcommand} failed: {completed.stderr.strip()}")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"cedar_validate.sh {subcommand} printed nothing")
    return lines[-1].strip()


def resolve_toolchain(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> tuple[str, str]:
    """The java binary and the library classpath, from the validation gate unless overridden."""
    if not BRIDGE_SOURCE.is_file():
        parser.error(f"bridge source not found: {BRIDGE_SOURCE}")
    try:
        java = arguments.java or run_validate_sh("java", 60)
        if arguments.classpath:
            classpath = arguments.classpath
        else:
            print("Resolving the validation library classpath (builds it on first use) ...", flush=True)
            classpath = run_validate_sh("classpath", 900)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        parser.error(str(error))
    if not Path(java).is_file():
        parser.error(f"java binary not found: {java}")
    return java, classpath


# --------------------------------------------------------------------------------------------------
# Templates for instances
# --------------------------------------------------------------------------------------------------


class TemplateResolver:
    """Shapes for the REST audit's instance rules, and the bodies the bridge validates against.

    Both caches are bounded the same way, so the bridge's copy and the shape usually live and die
    together; when they do not, a `template-missing` answer just costs one more GET.
    """

    def __init__(self, client: rest.GetOnlyClient, bridge: ValidationBridge, capacity: int):
        self.client = client
        self.bridge = bridge
        self.capacity = capacity
        self.shapes: collections.OrderedDict[str, rest.SchemaShape] = collections.OrderedDict()
        self.unresolved: dict[str, dict[str, Any]] = {}
        self.refetches = 0

    def remember(self, template_id: str, template: dict) -> None:
        shape = rest.build_schema_shape(template)
        self._store_shape(template_id, shape)
        body_id = template.get("@id")
        if isinstance(body_id, str) and body_id != template_id:
            self._store_shape(body_id, shape)
        self.bridge.cache_template(template_id, template)

    def _store_shape(self, template_id: str, shape: rest.SchemaShape) -> None:
        self.shapes[template_id] = shape
        self.shapes.move_to_end(template_id)
        while len(self.shapes) > self.capacity:
            self.shapes.popitem(last=False)

    def fetch(self, template_id: str) -> Optional[dict]:
        """The template body, fetched now; None when it cannot be read."""
        if template_id in self.unresolved:
            self.unresolved[template_id]["instances"] += 1
            return None
        try:
            template = self.client.get_json(rest.typed_artifact_path(rest.ArtifactRef("template", template_id)))
        except rest.AuthenticationError:
            raise
        except Exception as error:  # noqa: BLE001 - every failure is recorded against the instance
            self.unresolved[template_id] = {"error": str(error), "instances": 1}
            return None
        if not isinstance(template, dict):
            self.unresolved[template_id] = {"error": "template body is not a JSON object", "instances": 1}
            return None
        self.refetches += 1
        return template

    def shape(self, template_id: str) -> Optional[rest.SchemaShape]:
        shape = self.shapes.get(template_id)
        if shape is not None:
            self.shapes.move_to_end(template_id)
            return shape
        template = self.fetch(template_id)
        if template is None:
            return None
        self.remember(template_id, template)
        return self.shapes.get(template_id)

    def ensure_cached_in_bridge(self, template_id: str) -> bool:
        """After a `template-missing` answer: fetch the body and hand it to the bridge."""
        template = self.fetch(template_id)
        if template is None:
            return False
        self.remember(template_id, template)
        return True


# --------------------------------------------------------------------------------------------------
# Aggregation, progress and the summary
# --------------------------------------------------------------------------------------------------


MESSAGE_LIST = re.compile(r"\(\['[^']*'\]\)")
MESSAGE_QUOTED = re.compile(r"'[^']*'")
MESSAGE_DIGITS = re.compile(r"\d+")


def normalize_message(message: str) -> str:
    """Fold the names and numbers out of a validator message so like errors count together."""
    text = MESSAGE_LIST.sub("(['…'])", message)
    text = MESSAGE_QUOTED.sub("'…'", text)
    return MESSAGE_DIGITS.sub("N", text)


@dataclass
class Aggregate:
    """Everything the summary says, rebuilt from the records alone on resume."""
    processed_by_type: collections.Counter = field(default_factory=collections.Counter)
    fetched_by_type: collections.Counter = field(default_factory=collections.Counter)
    validation_by_type: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    skip_reasons_by_type: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    error_reasons: collections.Counter = field(default_factory=collections.Counter)
    validation_errors_total: collections.Counter = field(default_factory=collections.Counter)
    message_artifacts: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    message_occurrences: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    message_examples: dict[str, str] = field(default_factory=dict)
    condition_artifacts_by_type: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    condition_occurrences: collections.Counter = field(default_factory=collections.Counter)
    condition_by_validation: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    condition_risk: dict[str, str] = field(default_factory=dict)
    topic_artifacts: collections.Counter = field(default_factory=collections.Counter)
    topic_rules: dict[str, set[str]] = field(default_factory=lambda: collections.defaultdict(set))
    with_conditions_by_type: collections.Counter = field(default_factory=collections.Counter)
    with_conditions_but_valid_by_type: collections.Counter = field(default_factory=collections.Counter)
    schema_versions_by_type: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    invalid_instances_by_template: collections.Counter = field(default_factory=collections.Counter)
    instances_by_template: collections.Counter = field(default_factory=collections.Counter)
    title_case_only: collections.Counter = field(default_factory=collections.Counter)
    fetch_errors: list[dict[str, Any]] = field(default_factory=list)
    fetch_errors_by_status: collections.Counter = field(default_factory=collections.Counter)
    unresolved_templates: dict[str, dict[str, Any]] = field(default_factory=dict)
    bridge_incidents: int = 0

    @property
    def processed(self) -> int:
        return sum(self.processed_by_type.values())

    def validation_totals(self) -> collections.Counter:
        total: collections.Counter = collections.Counter()
        for counter in self.validation_by_type.values():
            total.update(counter)
        return total

    def add(self, record: dict[str, Any]) -> None:
        artifact_type = record["artifactType"]
        self.processed_by_type[artifact_type] += 1
        validation = record.get("validation") or {}
        status = validation.get("status", "skipped")
        if not record.get("fetched"):
            error = str((record.get("fetch") or {}).get("error", "unknown"))
            self.fetch_errors.append({
                "artifactType": artifact_type,
                "artifactId": record["artifactId"],
                "artifactName": record.get("artifactName", ""),
                "error": error,
            })
            match = re.search(r"returned (\d{3})", error)
            self.fetch_errors_by_status[match.group(1) if match else "other"] += 1
            self.validation_by_type[artifact_type]["skipped"] += 1
            self.skip_reasons_by_type[artifact_type]["fetch-failed"] += 1
            return
        self.fetched_by_type[artifact_type] += 1
        self.validation_by_type[artifact_type][status] += 1
        reason = validation.get("reason")
        if status == "skipped" and reason:
            self.skip_reasons_by_type[artifact_type][reason] += 1
        if status == "error" and reason:
            self.error_reasons[normalize_message(str(reason))] += 1
        if status == "invalid":
            self.validation_errors_total[artifact_type] += int(validation.get("errorCount") or 0)
            seen_here: set[str] = set()
            for error in validation.get("errors") or []:
                key = normalize_message(str(error.get("message", "")))
                self.message_occurrences[artifact_type][key] += 1
                if key not in seen_here:
                    self.message_artifacts[artifact_type][key] += 1
                    seen_here.add(key)
                self.message_examples.setdefault(key, str(error.get("message", "")))
        if artifact_type == "instance":
            template_id = validation.get("templateId")
            if template_id:
                self.instances_by_template[template_id] += 1
                if status == "invalid":
                    self.invalid_instances_by_template[template_id] += 1
            if reason == "template-unresolved" and template_id:
                entry = self.unresolved_templates.setdefault(
                    template_id, {"error": validation.get("detail", ""), "instances": 0})
                entry["instances"] += 1
        if artifact_type != "instance":
            self.schema_versions_by_type[artifact_type][record.get("schemaVersion") or "(absent)"] += 1

        rules_here: set[str] = set()
        topics_here: set[str] = set()
        for condition in record.get("conditions") or []:
            rule = condition["rule"]
            risk = condition.get("risk")
            self.condition_occurrences[rule] += 1
            if risk:
                self.condition_risk[rule] = risk
            if rule.startswith("title-not-canonical") and isinstance(condition.get("value"), dict) \
                    and condition["value"].get("caseOnly"):
                self.title_case_only[rule] += 1
            topic = TOPICS.get(rule) or (f"minting ({risk})" if risk else "minting")
            self.topic_rules[topic].add(rule)
            topics_here.add(topic)
            if rule not in rules_here:
                rules_here.add(rule)
                self.condition_artifacts_by_type[rule][artifact_type] += 1
                self.condition_by_validation[rule][status] += 1
        for topic in topics_here:
            self.topic_artifacts[topic] += 1
        if rules_here:
            self.with_conditions_by_type[artifact_type] += 1
            if status == "valid":
                self.with_conditions_but_valid_by_type[artifact_type] += 1


@dataclass
class Progress:
    started_monotonic: float = field(default_factory=time.monotonic)
    processing_started: Optional[float] = None
    processed_at_start: int = 0
    last_report_monotonic: float = field(default_factory=time.monotonic)
    batch_start: int = 0
    batch_by_type: collections.Counter = field(default_factory=collections.Counter)
    batch_validation: collections.Counter = field(default_factory=collections.Counter)
    batch_with_conditions: int = 0
    batch_fetch_errors: int = 0

    def note(self, record: dict[str, Any]) -> None:
        self.batch_by_type[record["artifactType"]] += 1
        if not record.get("fetched"):
            self.batch_fetch_errors += 1
        self.batch_validation[(record.get("validation") or {}).get("status", "skipped")] += 1
        if record.get("conditions"):
            self.batch_with_conditions += 1

    def reset(self, processed: int) -> None:
        self.batch_start = processed
        self.batch_by_type.clear()
        self.batch_validation.clear()
        self.batch_with_conditions = 0
        self.batch_fetch_errors = 0
        self.last_report_monotonic = time.monotonic()

    @property
    def elapsed(self) -> float:
        return max(0.0, time.monotonic() - self.started_monotonic)


def counts_text(counter: collections.Counter, keys: Optional[tuple[str, ...]] = None) -> str:
    if keys is None:
        items = counter.most_common()
    else:
        items = [(key, counter[key]) for key in keys if counter[key]]
    return " ".join(f"{key}={count}" for key, count in items) or "none"


def print_progress(aggregate: Aggregate, progress: Progress, total: int, final: bool = False) -> None:
    processed = aggregate.processed
    label = "final" if final else "checkpoint"
    percent = rest.completion_percent(processed, total)
    timing = f"elapsed={rest.format_duration(progress.elapsed)}"
    processing_elapsed = time.monotonic() - (progress.processing_started or progress.started_monotonic)
    done_this_run = processed - progress.processed_at_start
    if not final and 0 < done_this_run and processed < total and processing_elapsed > 0:
        eta = (total - processed) / (done_this_run / processing_elapsed)
        timing += f", eta={rest.format_duration(eta)}"
    totals = aggregate.validation_totals()
    print(
        f"[{label} {processed}/{total} {percent:.1f}%] batch {progress.batch_start + 1}-{processed} "
        f"({counts_text(progress.batch_by_type)}): {counts_text(progress.batch_validation, VALIDATION_STATUSES)}; "
        f"total: {counts_text(totals, VALIDATION_STATUSES)}; "
        f"with-conditions={progress.batch_with_conditions} batch/{sum(aggregate.with_conditions_by_type.values())} total; "
        f"fetch-errors={progress.batch_fetch_errors} batch/{len(aggregate.fetch_errors)} total; {timing}",
        flush=True,
    )


def summary_document(aggregate: Aggregate, enumeration: rest.AuditState, status: str,
                     arguments: argparse.Namespace, paths: dict[str, str], bridge: ValidationBridge,
                     started_at: str, progress: Progress, total: int) -> dict[str, Any]:
    validation_by_type = {
        kind: {name: counter[name] for name in VALIDATION_STATUSES}
        for kind, counter in sorted(aggregate.validation_by_type.items())
    }
    totals = aggregate.validation_totals()
    conditions = {}
    for rule in sorted(aggregate.condition_occurrences):
        by_type = aggregate.condition_artifacts_by_type[rule]
        entry: dict[str, Any] = {
            "topic": TOPICS.get(rule) or (
                f"minting ({aggregate.condition_risk[rule]})" if rule in aggregate.condition_risk else "minting"),
            "artifacts": sum(by_type.values()),
            "artifactsByType": dict(sorted(by_type.items())),
            "occurrences": aggregate.condition_occurrences[rule],
            "artifactsByValidation": {
                name: aggregate.condition_by_validation[rule][name] for name in VALIDATION_STATUSES
            },
        }
        if rule in aggregate.condition_risk:
            entry["risk"] = aggregate.condition_risk[rule]
        conditions[rule] = entry
    messages = {}
    for kind in sorted(aggregate.message_artifacts):
        messages[kind] = [
            {
                "message": key,
                "artifacts": count,
                "occurrences": aggregate.message_occurrences[kind][key],
                "example": aggregate.message_examples.get(key, ""),
            }
            for key, count in aggregate.message_artifacts[kind].most_common(40)
        ]
    return {
        "tool": {
            "script": Path(__file__).name,
            "scriptSha256": file_sha256(Path(__file__)),
            "bridgeSha256": file_sha256(BRIDGE_SOURCE),
            "restAuditRuleset": rest.AUDIT_RULESET_VERSION,
            "modelVersion": MODEL_VERSION,
            "bridge": {key: bridge.hello.get(key) for key in ("validator", "java", "templateCache")},
            "bridgeStarts": bridge.starts,
        },
        "status": status,
        "startedAt": started_at,
        "updatedAt": utc_now(),
        "elapsedSeconds": round(progress.elapsed, 3),
        "server": arguments.server,
        "scope": {
            "artifactTypes": arguments.selected_types,
            "selectedArtifactTotal": total,
            "searchReportedTotal": enumeration.expected_total,
            "limit": arguments.limit,
            "permissionScoped": True,
            "statement": "Complete means every artifact this API key can enumerate and read, "
                         "not store-wide completeness.",
            "httpMethods": ["GET"],
        },
        "completion": {
            "processed": aggregate.processed,
            "target": total,
            "percent": round(rest.completion_percent(aggregate.processed, total), 3),
        },
        "processedByType": dict(sorted(aggregate.processed_by_type.items())),
        "fetchedByType": dict(sorted(aggregate.fetched_by_type.items())),
        "expectedByType": enumeration.expected_by_type,
        "enumeratedByType": enumeration.enumerated_by_type,
        "paginationByType": enumeration.pagination_by_type,
        "validation": {
            "total": {name: totals[name] for name in VALIDATION_STATUSES},
            "byType": validation_by_type,
            "errorCountByType": dict(sorted(aggregate.validation_errors_total.items())),
            "skipReasonsByType": {
                kind: dict(counter.most_common()) for kind, counter in sorted(aggregate.skip_reasons_by_type.items())
            },
            "errorReasons": dict(aggregate.error_reasons.most_common(20)),
            "messagesByType": messages,
            "invalidInstancesByTemplate": [
                {"templateId": template_id, "invalid": count,
                 "instances": aggregate.instances_by_template[template_id]}
                for template_id, count in aggregate.invalid_instances_by_template.most_common(50)
            ],
            "templatesWithInvalidInstances": len(aggregate.invalid_instances_by_template),
        },
        "conditions": conditions,
        "conditionsByTopic": {
            topic: {"artifacts": aggregate.topic_artifacts[topic], "rules": sorted(rules)}
            for topic, rules in sorted(aggregate.topic_rules.items())
        },
        "titleDivergencesCaseOnly": dict(sorted(aggregate.title_case_only.items())),
        "artifactsWithConditionsByType": dict(sorted(aggregate.with_conditions_by_type.items())),
        "artifactsWithConditionsButValidByType": dict(sorted(aggregate.with_conditions_but_valid_by_type.items())),
        "schemaVersionsByType": {
            kind: dict(counter.most_common()) for kind, counter in sorted(aggregate.schema_versions_by_type.items())
        },
        "inventoryBoundary": {
            "fetchErrors": len(aggregate.fetch_errors),
            "fetchErrorsByStatus": dict(aggregate.fetch_errors_by_status.most_common()),
            "fetchErrorDetails": aggregate.fetch_errors[:1000],
            "listingErrors": enumeration.listing_errors,
            "duplicateSearchRowsSkipped": enumeration.duplicates,
            "searchTotalCountChanges": enumeration.total_count_changes,
            "unresolvedTemplates": len(aggregate.unresolved_templates),
            "unresolvedTemplateDetails": [
                {"templateId": template_id, **detail}
                for template_id, detail in sorted(aggregate.unresolved_templates.items(),
                                                  key=lambda item: -item[1]["instances"])[:500]
            ],
            "bridgeIncidents": aggregate.bridge_incidents,
        },
        "files": paths,
    }


# --------------------------------------------------------------------------------------------------
# Fetching ahead of validation
# --------------------------------------------------------------------------------------------------


def enumerate_with_progress(client: rest.GetOnlyClient, artifact_type: str, page_size: int,
                            enumeration: rest.AuditState, hard_limit: Optional[int]) -> list[rest.ArtifactRef]:
    """Enumerate one type, saying how far the walk has come while it runs.

    A large deployment takes hundreds of search pages before the first artifact is fetched, and a
    silent walk of that length reads as a hang.
    """
    expected = enumeration.expected_by_type.get(artifact_type)
    target = min(expected, hard_limit) if expected is not None and hard_limit is not None else expected
    started = time.monotonic()
    last_report = started
    found: list[rest.ArtifactRef] = []
    for ref in rest.iter_artifact_refs(client, artifact_type, page_size, enumeration, hard_limit):
        found.append(ref)
        now = time.monotonic()
        if now - last_report >= ENUMERATION_REPORT_SECONDS:
            last_report = now
            elapsed = now - started
            line = f"[enumerating {artifact_type}] {len(found)}"
            if target:
                line += f"/{target} rows ({rest.completion_percent(len(found), target):.1f}%)"
                if len(found) < target:
                    line += f", eta={rest.format_duration((target - len(found)) * elapsed / len(found))}"
            print(f"{line}; elapsed={rest.format_duration(elapsed)}", flush=True)
    print(f"[enumerated {artifact_type}] {len(found)} unique rows in {rest.format_duration(time.monotonic() - started)}",
          flush=True)
    return found


def fetch_artifact(client: rest.GetOnlyClient, ref: rest.ArtifactRef) -> tuple[Any, Optional[Exception]]:
    try:
        return client.get_json(rest.typed_artifact_path(ref)), None
    except Exception as error:  # noqa: BLE001 - the consumer decides which failures stop the run
        return None, error


def fetch_in_order(client: rest.GetOnlyClient, refs: list[rest.ArtifactRef], workers: int
                   ) -> Iterator[tuple[rest.ArtifactRef, Any, Optional[Exception]]]:
    """Fetch a few artifacts ahead of the consumer, and hand them over in enumeration order."""
    window = max(1, workers * 2)
    pending: collections.deque[tuple[rest.ArtifactRef, Future]] = collections.deque()
    position = 0
    executor = ThreadPoolExecutor(max_workers=max(1, workers))
    try:
        while position < len(refs) and len(pending) < window:
            ref = refs[position]
            position += 1
            pending.append((ref, executor.submit(fetch_artifact, client, ref)))
        while pending:
            ref, future = pending.popleft()
            artifact, error = future.result()
            if position < len(refs):
                next_ref = refs[position]
                position += 1
                pending.append((next_ref, executor.submit(fetch_artifact, client, next_ref)))
            yield ref, artifact, error
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


# --------------------------------------------------------------------------------------------------
# Refs manifest and resume
# --------------------------------------------------------------------------------------------------


def artifact_key(ref: rest.ArtifactRef) -> tuple[str, str]:
    return ref.artifact_type, ref.artifact_id


def manifest_expectations(arguments: argparse.Namespace) -> dict[str, Any]:
    return {
        "formatVersion": REFS_FORMAT_VERSION,
        "server": arguments.server,
        "artifactTypes": arguments.selected_types,
        "limit": arguments.limit,
        "modelVersion": MODEL_VERSION,
        "restAuditRuleset": rest.AUDIT_RULESET_VERSION,
        "scriptSha256": file_sha256(Path(__file__)),
        "bridgeSha256": file_sha256(BRIDGE_SOURCE),
    }


def write_refs_manifest(path: Path, arguments: argparse.Namespace, enumeration: rest.AuditState,
                        refs: list[rest.ArtifactRef], started_at: str) -> None:
    header = {
        "record": "validation-audit-manifest",
        **manifest_expectations(arguments),
        "startedAt": started_at,
        "expectedByType": enumeration.expected_by_type,
        "enumeratedByType": enumeration.enumerated_by_type,
        "paginationByType": enumeration.pagination_by_type,
        "listingErrors": enumeration.listing_errors,
        "duplicateSearchRowsSkipped": enumeration.duplicates,
        "searchTotalCountChanges": enumeration.total_count_changes,
        "artifactRefCount": len(refs),
    }
    with rest.open_private_text_file(path) as stream:
        stream.write(json.dumps(header, ensure_ascii=False) + "\n")
        for ref in refs:
            stream.write(json.dumps({
                "record": "artifact-ref",
                "artifactType": ref.artifact_type,
                "artifactId": ref.artifact_id,
                "artifactName": ref.name,
            }, ensure_ascii=False) + "\n")


def load_refs_manifest(path: Path, arguments: argparse.Namespace, parser: argparse.ArgumentParser
                       ) -> tuple[dict[str, Any], list[rest.ArtifactRef]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read resume refs file {path}: {error}")
    if not lines:
        parser.error(f"resume refs file is empty: {path}")
    try:
        records = [json.loads(line) for line in lines if line.strip()]
    except json.JSONDecodeError as error:
        parser.error(f"resume refs file is not valid JSONL: {path}:{error.lineno}: {error.msg}")
    header = records[0]
    if not isinstance(header, dict) or header.get("record") != "validation-audit-manifest":
        parser.error(f"resume refs file has no validation-audit-manifest header: {path}")
    mismatches = [name for name, value in manifest_expectations(arguments).items() if header.get(name) != value]
    if mismatches:
        parser.error("resume refs file does not match this invocation: " + ", ".join(mismatches)
                     + " (a changed script or bridge needs a new run)")
    refs: list[rest.ArtifactRef] = []
    for record in records[1:]:
        if not isinstance(record, dict) or record.get("record") != "artifact-ref":
            parser.error(f"resume refs file contains an unexpected record: {path}")
        refs.append(rest.ArtifactRef(str(record.get("artifactType", "")), str(record.get("artifactId", "")),
                                     str(record.get("artifactName", ""))))
    if len(refs) != header.get("artifactRefCount"):
        parser.error(f"resume refs file is incomplete: expected {header.get('artifactRefCount')} refs, "
                     f"found {len(refs)}")
    return header, refs


def load_existing_records(path: Path, parser: argparse.ArgumentParser) -> dict[tuple[str, str], dict[str, Any]]:
    """The last record for every artifact already in the output; a retried fetch supersedes its failure."""
    records: dict[tuple[str, str], dict[str, Any]] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read records file for --resume: {error}")
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            parser.error(f"invalid record in {path}:{line_number}: {error.msg}")
        if not isinstance(record, dict) or "artifactType" not in record or "artifactId" not in record:
            parser.error(f"record without an artifact key in {path}:{line_number}")
        records[(record["artifactType"], record["artifactId"])] = record
    return records


def restore_enumeration(header: dict[str, Any], limit: Optional[int]) -> rest.AuditState:
    enumeration = rest.AuditState(limit=limit, started_at=str(header.get("startedAt", utc_now())))
    enumeration.expected_by_type.update(header.get("expectedByType", {}))
    enumeration.enumerated_by_type.update(header.get("enumeratedByType", {}))
    enumeration.pagination_by_type.update(header.get("paginationByType", {}))
    enumeration.listing_errors = int(header.get("listingErrors", 0))
    enumeration.duplicates = int(header.get("duplicateSearchRowsSkipped", 0))
    enumeration.total_count_changes.extend(header.get("searchTotalCountChanges", []))
    enumeration.enumeration_complete = True
    return enumeration


# --------------------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------------------


def validation_result(bridge: ValidationBridge, resolver: TemplateResolver, ref: rest.ArtifactRef,
                      artifact: Any, aggregate: Aggregate) -> tuple[dict[str, Any], Optional[rest.SchemaShape]]:
    """The library's verdict for one artifact, and for an instance the shape of its template."""
    shape: Optional[rest.SchemaShape] = None
    result: dict[str, Any] = {"status": "skipped"}
    if ref.artifact_type == "instance":
        based_on = artifact.get("schema:isBasedOn") if isinstance(artifact, dict) else None
        if not rest.is_absolute_iri(based_on):
            result.update(reason="template-unusable", detail="schema:isBasedOn is not an absolute IRI")
            return result, None
        result["templateId"] = based_on
        shape = resolver.shape(based_on)
        if shape is None:
            result.update(reason="template-unresolved",
                          detail=resolver.unresolved.get(based_on, {}).get("error", ""))
            return result, None
    try:
        answer = bridge.validate(ref.artifact_type, artifact, result.get("templateId"))
        if answer.get("status") == "template-missing":
            if not resolver.ensure_cached_in_bridge(result["templateId"]):
                result.update(reason="template-unresolved",
                              detail=resolver.unresolved.get(result["templateId"], {}).get("error", ""))
                return result, shape
            answer = bridge.validate(ref.artifact_type, artifact, result["templateId"])
    except BridgeError as error:
        aggregate.bridge_incidents += 1
        result.update(status="error", reason=f"bridge: {error}")
        return result, shape
    status = answer.get("status")
    if status in {"valid", "invalid"}:
        errors = answer.get("errors") or []
        result.update(status=status, errorCount=len(errors), millis=answer.get("millis"))
        if errors:
            result["errors"] = errors
        if answer.get("warnings"):
            result["warnings"] = answer["warnings"]
    else:
        result.update(status="error",
                      reason=f"{answer.get('exception') or 'bridge'}: {answer.get('message') or status}")
    return result, shape


def run_audit(arguments: argparse.Namespace, client: rest.GetOnlyClient, bridge: ValidationBridge,
              records_stream, summary_path: Path, refs_path: Path, started_at: str) -> tuple[Aggregate, str]:
    aggregate = Aggregate()
    progress = Progress()
    completed: set[tuple[str, str]] = set()
    if arguments.resume:
        enumeration = arguments.resume_enumeration
        refs = arguments.resume_refs
        for key, record in arguments.resume_records.items():
            aggregate.add(record)
            if record.get("fetched"):
                completed.add(key)
        print(f"Resuming from {refs_path}: {len(completed)}/{len(refs)} artifacts already complete", flush=True)
    else:
        enumeration = rest.AuditState(limit=arguments.limit, started_at=started_at)
        refs = []
    resolver = TemplateResolver(client, bridge, arguments.template_cache)
    paths = {"records": str(arguments.out), "summary": str(summary_path), "refs": str(refs_path),
             "javaLog": str(arguments.java_log)}
    status = "RUNNING"
    total = 0

    def checkpoint(final: bool = False) -> None:
        nonlocal total
        if not final or aggregate.processed > progress.batch_start or aggregate.processed == 0:
            print_progress(aggregate, progress, total, final)
        rest.atomic_write_json(summary_path, summary_document(
            aggregate, enumeration, status if final else "RUNNING", arguments, paths, bridge,
            started_at, progress, total))
        progress.reset(aggregate.processed)

    def emit(record: dict[str, Any]) -> None:
        records_stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        records_stream.flush()
        aggregate.add(record)
        progress.note(record)
        if (aggregate.processed - progress.batch_start >= arguments.progress_every
                or time.monotonic() - progress.last_report_monotonic >= arguments.progress_seconds):
            checkpoint()

    try:
        if not arguments.resume:
            rest.preflight_expected_counts(client, arguments.selected_types, enumeration)
            reported = ", ".join(f"{kind}={enumeration.expected_by_type[kind]}" for kind in arguments.selected_types)
            print(f"Search reports: {enumeration.expected_total} rows ({reported}); enumerating unique IDs",
                  flush=True)
            for artifact_type in arguments.selected_types:
                remaining = None if arguments.limit is None else max(0, arguments.limit - len(refs))
                if remaining == 0:
                    break
                found = enumerate_with_progress(client, artifact_type, arguments.page_size, enumeration, remaining)
                enumeration.enumerated_by_type[artifact_type] = len(found)
                refs.extend(found)
            enumeration.enumeration_complete = True
            write_refs_manifest(refs_path, arguments, enumeration, refs, started_at)
        total = len(refs)
        selected = ", ".join(f"{kind}={enumeration.enumerated_by_type.get(kind, 0)}"
                             for kind in arguments.selected_types)
        limit_note = f"; sample limit={arguments.limit}" if arguments.limit is not None else ""
        print(f"Audit total: {total} unique artifacts ({selected}){limit_note}", flush=True)
        rest.atomic_write_json(summary_path, summary_document(
            aggregate, enumeration, "RUNNING", arguments, paths, bridge, started_at, progress, total))
        progress.processing_started = time.monotonic()
        progress.processed_at_start = aggregate.processed
        progress.reset(aggregate.processed)

        pending_refs = [ref for ref in refs if artifact_key(ref) not in completed]
        bridge_restarts = 0
        for ref, artifact, error in fetch_in_order(client, pending_refs, arguments.fetch_workers):
            record: dict[str, Any] = {
                "artifactType": ref.artifact_type,
                "artifactId": ref.artifact_id,
                "artifactName": ref.name,
                "fetched": error is None,
            }
            if error is not None:
                if isinstance(error, rest.AuthenticationError):
                    raise error
                record["fetch"] = {"error": str(error)}
                record["validation"] = {"status": "skipped", "reason": "fetch-failed"}
                record["conditions"] = []
                print(f"! could not fetch {ref.artifact_type} {ref.artifact_id}: {error}", file=sys.stderr)
                emit(record)
                continue

            if ref.artifact_type == "template" and isinstance(artifact, dict):
                try:
                    resolver.remember(ref.artifact_id, artifact)
                except BridgeError as bridge_error:
                    aggregate.bridge_incidents += 1
                    print(f"! bridge failed while caching a template: {bridge_error}", file=sys.stderr)
            if bridge.process is None:
                bridge_restarts += 1
                if bridge_restarts > arguments.bridge_max_restarts:
                    raise BridgeError(f"bridge failed {bridge_restarts} times; giving up")
                print(f"! restarting the validation bridge ({bridge_restarts}/{arguments.bridge_max_restarts})",
                      file=sys.stderr)
                bridge.start()
            validation, shape = validation_result(bridge, resolver, ref, artifact, aggregate)
            record["validation"] = validation
            conditions = inventory_conditions(ref, artifact, shape)
            record["conditions"] = [condition.json_record() for condition in conditions]
            rule_counts = collections.Counter(condition.rule for condition in conditions)
            record["conditionRules"] = dict(sorted(rule_counts.items()))
            if ref.artifact_type != "instance":
                record["schemaVersion"] = root_schema_version(artifact)
            emit(record)

        if aggregate.fetch_errors or enumeration.listing_errors or aggregate.unresolved_templates \
                or aggregate.bridge_incidents:
            status = "PARTIAL_ERRORS"
        elif enumeration.total_count_changes or enumeration.duplicates:
            status = "PARTIAL_CONCURRENT_CHANGES"
        elif arguments.limit is not None and aggregate.processed >= arguments.limit:
            status = f"SAMPLE_LIMIT_{arguments.limit}"
        else:
            status = "COMPLETE_FOR_KEY"
    except KeyboardInterrupt:
        status = "PARTIAL_INTERRUPTED"
    except rest.AuthenticationError as error:
        status = "PARTIAL_AUTHENTICATION_ERROR"
        print(f"! {error}", file=sys.stderr)
    except BridgeError as error:
        status = "PARTIAL_BRIDGE_FAILURE"
        print(f"! {error}", file=sys.stderr)
    except Exception as error:  # noqa: BLE001 - the partial report is the point
        status = f"PARTIAL_{type(error).__name__.upper()}"
        enumeration.listing_errors += 1
        print(f"! audit stopped: {type(error).__name__}: {error}", file=sys.stderr)
    finally:
        checkpoint(final=True)
    return aggregate, status


# --------------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate every artifact an API key can read with cedar-model-validation-library, "
                    "and count the legacy shapes the backend roadmap's production-data item lists.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="The records JSONL holds verdicts and condition paths, never full artifacts or the API key. "
               "A COMPLETE_FOR_KEY result is permission-scoped and does not prove Mongo/graph parity.",
    )
    parser.add_argument("--server", default=rest.DEFAULT_SERVER,
                        help=f"resource server origin (default: {rest.DEFAULT_SERVER})")
    parser.add_argument("--api-key-file",
                        help="read the API key from this one-line file; otherwise CEDAR_API_KEY or a prompt")
    parser.add_argument("--types", default=DEFAULT_TYPES,
                        help="comma-separated artifact types or all (default: all)")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE,
                        help=f"search-deep page size; the server caps it at its maxPageSize (default: {DEFAULT_PAGE_SIZE})")
    parser.add_argument("--limit", type=int, help="quick sample: stop after this many artifacts total")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help=f"report and checkpoint every N artifacts (default: {DEFAULT_PROGRESS_EVERY})")
    parser.add_argument("--progress-seconds", type=float, default=DEFAULT_PROGRESS_SECONDS,
                        help=f"also report when this many seconds have passed (default: {DEFAULT_PROGRESS_SECONDS})")
    parser.add_argument("--fetch-workers", type=int, default=DEFAULT_FETCH_WORKERS,
                        help=f"concurrent GETs fetching ahead of validation (default: {DEFAULT_FETCH_WORKERS})")
    parser.add_argument("--out", default="cedar-artifact-validation.jsonl",
                        help="one JSON record per artifact (default: cedar-artifact-validation.jsonl)")
    parser.add_argument("--summary", help="summary JSON path (default: <out without suffix>-summary.json)")
    parser.add_argument("--refs", help="enumerated refs JSONL path (default: <out without suffix>-refs.jsonl)")
    parser.add_argument("--java-log", help="the JVM's stderr (default: <out without suffix>-java.log)")
    parser.add_argument("--resume", action="store_true",
                        help="continue from --refs, appending to the existing records")
    parser.add_argument("--java", help="java binary (default: what cedar_validate.sh java resolves)")
    parser.add_argument("--classpath",
                        help="validation library classpath (default: what cedar_validate.sh classpath resolves)")
    parser.add_argument("--jvm-heap", default="2g", help="JVM maximum heap (default: 2g)")
    parser.add_argument("--template-cache", type=int, default=DEFAULT_TEMPLATE_CACHE,
                        help=f"templates kept for instance validation (default: {DEFAULT_TEMPLATE_CACHE})")
    parser.add_argument("--bridge-timeout", type=float, default=DEFAULT_BRIDGE_TIMEOUT,
                        help=f"seconds to wait for one verdict before restarting the JVM (default: {DEFAULT_BRIDGE_TIMEOUT})")
    parser.add_argument("--bridge-max-restarts", type=int, default=DEFAULT_BRIDGE_MAX_RESTARTS,
                        help=f"JVM restarts tolerated before the run stops (default: {DEFAULT_BRIDGE_MAX_RESTARTS})")
    parser.add_argument("--timeout", type=float, default=90, help="per-request timeout in seconds (default: 90)")
    parser.add_argument("--retries", type=int, default=5, help="attempts for transient failures (default: 5)")
    parser.add_argument("--delay-ms", type=int, default=0, help="polite delay before every request (default: 0)")
    parser.add_argument("--ca-file", help="additional CA bundle for a trusted private HTTPS deployment")
    parser.add_argument("--allow-http", action="store_true",
                        help="allow plain HTTP; intended only for a local test server")
    parser.add_argument("--fail-on-invalid", action="store_true",
                        help="exit 1 after a complete run when any artifact is invalid")
    return parser


def print_final_summary(aggregate: Aggregate, status: str, total: int, paths: dict[str, Path]) -> None:
    totals = aggregate.validation_totals()
    print("\n=== Final summary ===")
    print(f"status: {status}")
    print(f"artifacts: processed={aggregate.processed}/{total}; "
          f"validation: {counts_text(totals, VALIDATION_STATUSES)}")
    for kind in rest.TYPE_ORDER:
        counter = aggregate.validation_by_type.get(kind)
        if counter:
            print(f"  {kind:<9} {counts_text(counter, VALIDATION_STATUSES)}")
    if aggregate.invalid_instances_by_template:
        print(f"templates with invalid instances: {len(aggregate.invalid_instances_by_template)}")
    print(f"artifacts with conditions: {sum(aggregate.with_conditions_by_type.values())} "
          f"(valid among them: {sum(aggregate.with_conditions_but_valid_by_type.values())})")
    if aggregate.condition_occurrences:
        width = max(len(rule) for rule in aggregate.condition_occurrences)
        print(f"  {'condition':<{width}}  artifacts  occurrences  valid  invalid")
        for rule, occurrences in sorted(aggregate.condition_occurrences.items(),
                                        key=lambda item: -sum(aggregate.condition_artifacts_by_type[item[0]].values())):
            artifacts = sum(aggregate.condition_artifacts_by_type[rule].values())
            by_validation = aggregate.condition_by_validation[rule]
            print(f"  {rule:<{width}}  {artifacts:>9}  {occurrences:>11}  {by_validation['valid']:>5}  "
                  f"{by_validation['invalid']:>7}")
    if aggregate.title_case_only:
        print(f"title divergences differing only in letter case: {counts_text(aggregate.title_case_only)}")
    for kind, versions in sorted(aggregate.schema_versions_by_type.items()):
        print(f"schema versions ({kind}): {counts_text(versions)}")
    print(f"fetch errors: {len(aggregate.fetch_errors)}; unresolved templates: {len(aggregate.unresolved_templates)}; "
          f"bridge incidents: {aggregate.bridge_incidents}")
    print(f"records: {paths['records']}")
    print(f"summary: {paths['summary']}")
    print("No artifact writes were issued; the HTTP client supports GET only.")


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    for name in ("page_size", "progress_every", "retries", "template_cache", "fetch_workers", "bridge_max_restarts"):
        if getattr(arguments, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    for name in ("progress_seconds", "timeout", "bridge_timeout"):
        if getattr(arguments, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if arguments.limit is not None and arguments.limit <= 0:
        parser.error("--limit must be positive")
    arguments.selected_types = rest.parse_types(arguments.types, parser)
    api_key = rest.resolve_api_key(arguments, parser)

    records_path = Path(arguments.out).expanduser()
    stem = records_path.stem
    summary_path = Path(arguments.summary).expanduser() if arguments.summary \
        else records_path.with_name(stem + "-summary.json")
    refs_path = Path(arguments.refs).expanduser() if arguments.refs \
        else records_path.with_name(stem + "-refs.jsonl")
    java_log_path = Path(arguments.java_log).expanduser() if arguments.java_log \
        else records_path.with_name(stem + "-java.log")
    if len({path.resolve() for path in (records_path, summary_path, refs_path, java_log_path)}) != 4:
        parser.error("--out, --summary, --refs and --java-log must name different files")
    arguments.out = str(records_path)
    arguments.java_log = str(java_log_path)
    arguments.server = arguments.server.rstrip("/")
    for path in (records_path, summary_path, refs_path, java_log_path):
        path.parent.mkdir(parents=True, exist_ok=True)

    if arguments.resume:
        header, refs = load_refs_manifest(refs_path, arguments, parser)
        records = load_existing_records(records_path, parser)
        known = {artifact_key(ref) for ref in refs}
        if set(records) - known:
            parser.error("records file contains artifact IDs absent from the resume refs file")
        arguments.resume_refs = refs
        arguments.resume_records = records
        arguments.resume_enumeration = restore_enumeration(header, arguments.limit)
        started_at = str(header.get("startedAt", utc_now()))
    else:
        started_at = utc_now()

    java, classpath = resolve_toolchain(arguments, parser)
    try:
        client = rest.GetOnlyClient(
            arguments.server, api_key, timeout=arguments.timeout, retries=arguments.retries,
            delay_ms=arguments.delay_ms, ca_file=arguments.ca_file, allow_http=arguments.allow_http,
        )
    except (ValueError, OSError) as error:
        parser.error(str(error))

    bridge = ValidationBridge(java, classpath, BRIDGE_SOURCE, arguments.template_cache, arguments.jvm_heap,
                              java_log_path, arguments.bridge_timeout)
    print(f"GET-only validation audit of {arguments.server}")
    print(f"Scope: {', '.join(arguments.selected_types)}; permission-scoped to this key")
    print(f"Model version: {MODEL_VERSION}; REST audit ruleset: {rest.AUDIT_RULESET_VERSION}")
    print(f"Records: {records_path}; summary: {summary_path}; refs: {refs_path}; JVM log: {java_log_path}")
    print("Mode: resume (append records, reuse enumerated refs)" if arguments.resume else "Mode: new audit")
    print(f"Progress: every {arguments.progress_every} artifacts or {arguments.progress_seconds:.0f}s; "
          f"{arguments.fetch_workers} fetch worker(s); template cache {arguments.template_cache}")
    try:
        hello = bridge.start()
    except (BridgeError, TimeoutError, OSError) as error:
        parser.error(f"cannot start the validation bridge: {error} (see {java_log_path})")
    print(f"Validator: {hello.get('validator')} on Java {hello.get('java')}", flush=True)

    try:
        with rest.open_private_text_file(records_path, append=arguments.resume) as records_stream:
            aggregate, status = run_audit(arguments, client, bridge, records_stream, summary_path, refs_path,
                                          started_at)
    except OSError as error:
        bridge.close()
        parser.error(f"cannot open records file securely: {error}")
    finally:
        bridge.close()

    total = len(arguments.resume_refs) if arguments.resume else \
        int(json.loads(summary_path.read_text(encoding="utf-8"))["completion"]["target"])
    print_final_summary(aggregate, status, total, {"records": records_path, "summary": summary_path})
    if status.startswith("PARTIAL"):
        return 2
    if arguments.fail_on_invalid and aggregate.validation_totals()["invalid"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
