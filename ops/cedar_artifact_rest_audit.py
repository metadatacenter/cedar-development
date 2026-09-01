#!/usr/bin/env python3
"""Read-only REST audit for artifacts affected by CEDAR's hardened minting rules.

The auditor defaults to every template and element visible to one API key through ``/search-deep``;
``--types all`` adds standalone fields and instances. It fetches each full artifact through its typed
resource endpoint and issues GET requests only.

Enumeration follows the continuation each page carries rather than counting offsets, so a page costs
one request wherever it falls and the whole pass reads one snapshot of the search index. Against a
server that predates continuations it detects the first answer that carries none while reporting more
rows than it returned, and falls back to offsets; the refs manifest records which of the two ran. Findings are streamed as JSONL, a machine-readable
summary is checkpointed every 300 artifacts by default, and a concise progress line reports both the
processed and selected totals at the same interval. An adjacent refs JSONL stores the exact audit set
and per-artifact completions so an interrupted run can continue with ``--resume``.

Enumeration is permission-scoped: "complete" means complete for what the supplied key can read and
what the resource server's graph can enumerate. It is not a substitute for a store query when the key
cannot see the entire deployment or when the graph and artifact store have drifted.

Keep credentials out of shell history and the process list:

    export CEDAR_API_KEY=...
    python3 ops/cedar_artifact_rest_audit.py \
      --server https://resource.metadatacenter.org \
      --out production-schema-findings.jsonl

No third-party packages are required.
"""

from __future__ import annotations

import argparse
import collections
import getpass
import hashlib
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional


DEFAULT_SERVER = "https://resource.metadatacenter.org"
DEFAULT_PROGRESS_EVERY = 300
REFS_FORMAT_VERSION = 1
DEFAULT_TYPES = ("template", "element")
ARTIFACT_PATHS = {
    "template": "templates",
    "element": "template-elements",
    "field": "template-fields",
    "instance": "template-instances",
}
TYPE_ORDER = ("template", "element", "field", "instance")

# Stored in every summary so a long-running result says which behavior it actually audited. The
# script hash distinguishes edits made without changing this human-readable ruleset version.
AUDIT_RULESET_VERSION = "2026-08-18.2"
# What /search-deep takes to begin a walk, in the parameter it hands positions back in.
SEARCH_CONTINUATION_START = "start"
BEHAVIORAL_BASELINES = {
    "cedar-artifact-library": "9250a4f",
    "cedar-model-typescript-library": "bf97976",
    "cedar-artifact-server": "c9be99d",
    "cedar-config-library": "e729862",
    "cedar-server-utils": "826839e2",
}

TEMPLATE_ELEMENT = "https://schema.metadatacenter.org/core/TemplateElement"
TEMPLATE_FIELD = "https://schema.metadatacenter.org/core/TemplateField"
STATIC_TEMPLATE_FIELD = "https://schema.metadatacenter.org/core/StaticTemplateField"
RECOGNISED_CHILD_TYPES = {TEMPLATE_ELEMENT, TEMPLATE_FIELD, STATIC_TEMPLATE_FIELD}

NON_SERIALIZING_INPUT_TYPES = {
    "page-break", "section-break", "richtext", "image", "youtube", "attribute-value",
}
RESERVED_ATTRIBUTE_VALUE_NAMES = {
    "@context", "@id", "@type", "@value", "@language",
    "schema:isBasedOn", "schema:name", "schema:description",
    "pav:derivedFrom", "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn",
    "oslc:modifiedBy", "rdfs:label", "skos:prefLabel", "skos:altLabel",
    "skos:notation", "_annotations",
}
CONTEXT_PREFIXES = {
    "schema", "pav", "oslc", "rdfs", "xsd", "skos", "bibo", "dc", "dcterms", "prov",
    "rdf", "owl",
}
SYSTEM_CONTEXT_KEYS = {
    "schema:isBasedOn", "schema:name", "schema:description", "pav:derivedFrom", "pav:createdOn",
    "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy", "skos:notation", "rdfs:label",
    "schema:identifier",
}
SPECIAL_CHILD_NAME = re.compile(r"(^@)|(^_)|(^schema:)|(^pav:)|(^oslc:)")
URI_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
REPOSITORY_PROPERTY_IRI_PREFIX = "https://schema.metadatacenter.org/properties/"
JSON_SCHEMA_DRAFT_04 = "http://json-schema.org/draft-04/schema#"
VALUE_ATOM_KEYS = {
    "@value", "@id", "rdfs:label", "@type", "skos:notation", "skos:prefLabel", "@language",
}


class AuditError(Exception):
    """Base class for controlled failures that should produce a partial report."""


class AuthenticationError(AuditError):
    """The API key was refused."""


class ResponseError(AuditError):
    """A REST response could not be used."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not forward the API key to a redirect target, even accidentally."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib signature
        return None


@dataclass(frozen=True)
class ArtifactRef:
    artifact_type: str
    artifact_id: str
    name: str = ""


@dataclass(frozen=True)
class Finding:
    rule: str
    risk: str
    artifact_type: str
    artifact_id: str
    artifact_name: str
    path: str
    message: str
    value: Any = None

    def json_record(self) -> dict[str, Any]:
        record = asdict(self)
        if self.value is None:
            record.pop("value")
        return record


@dataclass
class ChildShape:
    at_type: Optional[str]
    input_type: str
    multiple: bool
    shape: "SchemaShape"

    @property
    def is_element(self) -> bool:
        return self.at_type == TEMPLATE_ELEMENT


@dataclass
class SchemaShape:
    children: dict[str, ChildShape] = field(default_factory=dict)
    attribute_groups: set[str] = field(default_factory=set)
    serializing_children: set[str] = field(default_factory=set)


@dataclass
class AuditState:
    limit: Optional[int] = None
    started_at: str = field(default_factory=lambda: utc_now())
    started_monotonic: float = field(default_factory=time.monotonic, repr=False)
    processing_started_monotonic: Optional[float] = field(default=None, repr=False)
    processed: int = 0
    fetched: int = 0
    processed_by_type: collections.Counter = field(default_factory=collections.Counter)
    fetched_by_type: collections.Counter = field(default_factory=collections.Counter)
    findings_by_type: collections.Counter = field(default_factory=collections.Counter)
    affected_artifacts: set[tuple[str, str]] = field(default_factory=set)
    affected_by_type: dict[str, set[tuple[str, str]]] = field(
        default_factory=lambda: collections.defaultdict(set)
    )
    affected_by_rule: dict[str, set[tuple[str, str]]] = field(
        default_factory=lambda: collections.defaultdict(set)
    )
    affected_by_risk: dict[str, set[tuple[str, str]]] = field(
        default_factory=lambda: collections.defaultdict(set)
    )
    finding_counts: collections.Counter = field(default_factory=collections.Counter)
    risk_counts: collections.Counter = field(default_factory=collections.Counter)
    fetch_errors: int = 0
    listing_errors: int = 0
    unresolved_templates: int = 0
    duplicates: int = 0
    expected_by_type: dict[str, int] = field(default_factory=dict)
    enumerated_by_type: dict[str, int] = field(default_factory=dict)
    pagination_by_type: dict[str, str] = field(default_factory=dict)
    enumeration_complete: bool = False
    total_count_changes: list[dict[str, Any]] = field(default_factory=list)
    fetch_error_details: list[dict[str, Any]] = field(default_factory=list)
    unresolved_template_details: list[dict[str, Any]] = field(default_factory=list)
    batch_start: int = 0
    batch_per_type: collections.Counter = field(default_factory=collections.Counter)
    batch_affected: set[tuple[str, str]] = field(default_factory=set)
    batch_findings: collections.Counter = field(default_factory=collections.Counter)
    batch_risks: collections.Counter = field(default_factory=collections.Counter)
    batch_fetch_errors: int = 0

    @property
    def expected_total(self) -> int:
        return sum(self.expected_by_type.values())

    @property
    def enumerated_total(self) -> int:
        return sum(self.enumerated_by_type.values())

    @property
    def planned_total(self) -> int:
        total = self.enumerated_total if self.enumeration_complete else self.expected_total
        return min(total, self.limit) if self.limit is not None else total

    @property
    def elapsed_seconds(self) -> float:
        return max(0.0, time.monotonic() - self.started_monotonic)

    @property
    def processing_elapsed_seconds(self) -> float:
        started = self.processing_started_monotonic or self.started_monotonic
        return max(0.0, time.monotonic() - started)

    def add_findings(self, ref: ArtifactRef, findings: Iterable[Finding]) -> list[Finding]:
        found = list(findings)
        if found:
            key = (ref.artifact_type, ref.artifact_id)
            self.affected_artifacts.add(key)
            self.affected_by_type[ref.artifact_type].add(key)
            self.batch_affected.add(key)
        for finding in found:
            key = (finding.artifact_type, finding.artifact_id)
            self.finding_counts[finding.rule] += 1
            self.risk_counts[finding.risk] += 1
            self.findings_by_type[finding.artifact_type] += 1
            self.affected_by_rule[finding.rule].add(key)
            self.affected_by_risk[finding.risk].add(key)
            self.batch_findings[finding.rule] += 1
            self.batch_risks[finding.risk] += 1
        return found

    def artifact_processed(self, artifact_type: str, fetched: bool) -> None:
        self.processed += 1
        self.processed_by_type[artifact_type] += 1
        self.batch_per_type[artifact_type] += 1
        if fetched:
            self.fetched += 1
            self.fetched_by_type[artifact_type] += 1

    def add_diagnostic(self, diagnostic: Finding) -> None:
        """Count an audit failure without calling the unread artifact defective."""
        self.finding_counts[diagnostic.rule] += 1
        self.risk_counts[diagnostic.risk] += 1
        self.findings_by_type[diagnostic.artifact_type] += 1
        self.batch_findings[diagnostic.rule] += 1
        self.batch_risks[diagnostic.risk] += 1

    def reset_batch(self) -> None:
        self.batch_start = self.processed
        self.batch_per_type.clear()
        self.batch_affected.clear()
        self.batch_findings.clear()
        self.batch_risks.clear()
        self.batch_fetch_errors = 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def script_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def json_pointer_component(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def child_path(parent: str, name: str) -> str:
    return f"{parent}/properties/{json_pointer_component(name)}"


def is_well_formed_uri_reference(value: Any) -> bool:
    """Accept absolute or relative URI references that the model readers can represent."""
    if not isinstance(value, str) or not value or value.isspace() or value != value.strip():
        return False
    if any(ch.isspace() or ord(ch) < 0x20 for ch in value):
        return False
    if re.search(r"%(?![0-9A-Fa-f]{2})|[<>\"{}|\\^`]", value):
        return False
    try:
        urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return True


def is_absolute_iri(value: Any) -> bool:
    """Apply the canonical persistence rule: a clean, well-formed URI with a scheme."""
    if not is_well_formed_uri_reference(value):
        return False
    parsed = urllib.parse.urlsplit(value)
    return bool(parsed.scheme) and bool(URI_SCHEME.match(value))


def server_considers_child_id_usable(value: Any) -> bool:
    """Mirror ModelUtil.hasUsableChildId, including its trim-before-test behavior."""
    return isinstance(value, str) and is_absolute_iri(value.strip())


def is_repository_property_iri(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(REPOSITORY_PROPERTY_IRI_PREFIX)


def direct_schema_children(container: Any) -> Iterator[tuple[str, Optional[dict], bool, Optional[str]]]:
    """Yield the same schema-child candidates the artifact server treats as fields/elements.

    The fourth value is an error for a malformed multi-instance child. Keeping that candidate in the
    stream lets the auditor report it instead of silently skipping the shape the server will refuse.
    """
    if not isinstance(container, dict):
        return
    properties = container.get("properties")
    if not isinstance(properties, dict):
        return
    for name, declared in properties.items():
        if SPECIAL_CHILD_NAME.search(name) or not isinstance(declared, dict) or "type" not in declared:
            continue
        declared_type = declared.get("type")
        if declared_type == "array":
            item = declared.get("items")
            if not isinstance(item, dict):
                yield name, None, True, "multi-instance child has no items object"
            else:
                yield name, item, True, None
        elif declared_type == "object":
            yield name, declared, False, None


def build_schema_shape(container: Any) -> SchemaShape:
    shape = SchemaShape()
    for name, child, multiple, error in direct_schema_children(container):
        if error or child is None:
            continue
        if not isinstance(child.get("_ui"), dict):
            continue
        ui = child["_ui"]
        input_type = ui.get("inputType") if isinstance(ui.get("inputType"), str) else ""
        at_type = child.get("@type") if isinstance(child.get("@type"), str) else None
        nested = build_schema_shape(child)
        shape.children[name] = ChildShape(at_type, input_type, multiple, nested)
        if input_type == "attribute-value":
            shape.attribute_groups.add(name)
        elif input_type not in NON_SERIALIZING_INPUT_TYPES:
            shape.serializing_children.add(name)
    return shape


def finding(ref: ArtifactRef, rule: str, risk: str, path: str, message: str,
            value: Any = None) -> Finding:
    return Finding(rule, risk, ref.artifact_type, ref.artifact_id, ref.name, path or "/", message, value)


def audit_common(ref: ArtifactRef, artifact: Any) -> Iterator[Finding]:
    if not isinstance(artifact, dict):
        yield finding(ref, "artifact-not-object", "save-rejected", "/",
                      "full artifact response is not a JSON object")
        return

    root_id = artifact.get("@id")
    if root_id is None:
        yield finding(ref, "root-id-missing", "save-rejected", "/@id",
                      "stored artifact has no @id")
    elif not is_absolute_iri(root_id):
        yield finding(ref, "root-id-unusable", "save-rejected", "/@id",
                      "stored artifact @id is not an absolute IRI", root_id)
    if isinstance(root_id, str) and root_id != ref.artifact_id:
        yield finding(ref, "root-id-mismatch", "save-rejected", "/@id",
                      "body @id does not match the identifier returned by search", root_id)

    def walk(node: Any, path: str) -> Iterator[Finding]:
        if isinstance(node, dict):
            derived_from = node.get("pav:derivedFrom")
            if isinstance(derived_from, str) and not is_absolute_iri(derived_from):
                if derived_from == "":
                    yield finding(
                        ref, "derived-from-empty", "repair-on-save", f"{path}/pav:derivedFrom",
                        "the TypeScript compatibility reader loads this as absent and an ordinary update removes "
                        "the inherited value; the strict Java reader rejects it until repaired",
                        derived_from,
                    )
                else:
                    yield finding(
                        ref, "derived-from-unusable", "repair-on-save", f"{path}/pav:derivedFrom",
                        "an ordinary update removes this inherited non-absolute provenance IRI; strict readers may "
                        "reject it and a newly introduced value is rejected",
                        derived_from,
                    )
            ui = node.get("_ui")
            if isinstance(ui, dict) and "pages" in ui:
                yield finding(ref, "ui-pages-forbidden", "save-rejected", f"{path}/_ui/pages",
                              "_ui.pages is forbidden by the current meta-schema", ui.get("pages"))
            for key, value in node.items():
                yield from walk(value, f"{path}/{json_pointer_component(key)}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                yield from walk(value, f"{path}/{index}")

    yield from walk(artifact, "")


def mapping_value(context_properties: Any, name: str) -> tuple[str, Any]:
    """Return (state, value) for one schema child property mapping."""
    if not isinstance(context_properties, dict) or name not in context_properties:
        return "missing", None
    mapping = context_properties.get(name)
    if not isinstance(mapping, dict):
        return "malformed", mapping
    values = mapping.get("enum")
    if not isinstance(values, list) or len(values) != 1:
        return "malformed", values
    value = values[0]
    if not is_absolute_iri(value):
        return "unusable", value
    return "usable", value


def expected_child_id_prefix(at_type: Optional[str]) -> Optional[str]:
    if at_type == TEMPLATE_ELEMENT:
        return "/template-elements/"
    if at_type in {TEMPLATE_FIELD, STATIC_TEMPLATE_FIELD}:
        return "/template-fields/"
    return None


def mismatched_child_prefix(identifier: str, at_type: Optional[str]) -> bool:
    expected = expected_child_id_prefix(at_type)
    if not expected:
        return False
    other = "/template-fields/" if expected == "/template-elements/" else "/template-elements/"
    return expected not in identifier and other in identifier


def audit_schema(ref: ArtifactRef, artifact: Any) -> Iterator[Finding]:
    if not isinstance(artifact, dict):
        return

    if "$schema" not in artifact:
        yield finding(ref, "root-schema-missing", "save-rejected", "/$schema",
                      "artifact root must declare the draft-04 JSON Schema URI")
    elif artifact.get("$schema") != JSON_SCHEMA_DRAFT_04:
        yield finding(ref, "root-schema-invalid", "save-rejected", "/$schema",
                      "artifact root must declare the canonical draft-04 JSON Schema URI",
                      artifact.get("$schema"))

    def walk(container: dict, path: str) -> Iterator[Finding]:
        properties = container.get("properties")
        context_schema = properties.get("@context") if isinstance(properties, dict) else None
        context_properties = context_schema.get("properties") if isinstance(context_schema, dict) else None
        required = context_schema.get("required") if isinstance(context_schema, dict) else None
        required_names = {value for value in required if isinstance(value, str)} \
            if isinstance(required, list) else set()
        can_mint_mapping = isinstance(context_properties, dict)
        can_require_child = isinstance(context_schema, dict) and (required is None or isinstance(required, list))

        for name, child, multiple, shape_error in direct_schema_children(container):
            declared_path = child_path(path, name)
            actual_path = f"{declared_path}/items" if multiple else declared_path
            if shape_error or child is None:
                yield finding(ref, "child-shape-invalid", "save-rejected", declared_path,
                              shape_error or "child schema is malformed")
                continue

            if "$schema" not in child:
                yield finding(ref, "child-schema-missing", "repair-on-save", f"{actual_path}/$schema",
                              "ordinary update restores the inherited draft-04 declaration; "
                              "a new omission and verbatim update are rejected")
            elif child.get("$schema") != JSON_SCHEMA_DRAFT_04:
                yield finding(ref, "child-schema-invalid", "save-rejected", f"{actual_path}/$schema",
                              "explicit child $schema must be the canonical draft-04 URI",
                              child.get("$schema"))

            at_type = child.get("@type")
            if at_type not in RECOGNISED_CHILD_TYPES:
                yield finding(ref, "child-type-unrecognised", "save-rejected", f"{actual_path}/@type",
                              "child must declare TemplateElement, TemplateField, or StaticTemplateField", at_type)

            identifier = child.get("@id")
            if not server_considers_child_id_usable(identifier):
                yield finding(ref, "child-id-unusable", "repair-on-save", f"{actual_path}/@id",
                              "ordinary update mints a child ID; verbatim update rejects this value", identifier)
            elif not is_absolute_iri(identifier):
                yield finding(
                    ref, "child-id-surrounding-whitespace", "save-rejected", f"{actual_path}/@id",
                    "the child-ID normalizer trims only while deciding that this is usable, so it does not mint a "
                    "replacement and request validation sees the original whitespace",
                    identifier,
                )
            elif mismatched_child_prefix(identifier, at_type):
                yield finding(ref, "child-id-prefix-mismatch", "manual-review", f"{actual_path}/@id",
                              "child ID prefix contradicts @type and is deliberately not rewritten automatically",
                              identifier)

            ui = child.get("_ui")
            if isinstance(ui, dict):
                input_type = ui.get("inputType") if isinstance(ui.get("inputType"), str) else ""
                constraints = child.get("_valueConstraints")
                inherently_multiple = (
                    input_type in {"checkbox", "attribute-value"}
                    or input_type == "list" and isinstance(constraints, dict)
                    and constraints.get("multipleChoice") is True
                )
                if inherently_multiple and not multiple:
                    yield finding(
                        ref, "inherently-multiple-child-object", "instance-save-rejected", declared_path,
                        "checkbox, attribute-value, and multiple-choice list deployments must be arrays; "
                        "CEE emits an array that this exact stored schema rejects",
                        input_type,
                    )
                state, value = mapping_value(context_properties, name)
                if input_type not in NON_SERIALIZING_INPUT_TYPES:
                    if state == "missing":
                        yield finding(ref, "child-property-iri-missing",
                                      "repair-on-save" if can_mint_mapping else "save-rejected",
                                      f"{path}/properties/@context/properties/{json_pointer_component(name)}",
                                      "ordinary update mints the missing child property IRI"
                                      if can_mint_mapping else
                                      "@context.properties is not an object, so normal minting cannot add this mapping")
                    elif state != "usable":
                        yield finding(ref, "child-property-iri-unusable",
                                      "repair-on-save" if can_mint_mapping else "save-rejected",
                                      f"{path}/properties/@context/properties/{json_pointer_component(name)}",
                                      "inherited unusable mapping is removed and reminted; a newly introduced one is rejected",
                                      value)
                    if name not in required_names:
                        yield finding(ref, "child-context-required-missing",
                                      "repair-on-save" if can_require_child else "save-rejected",
                                      f"{path}/properties/@context/required",
                                      "ordinary update adds the mapped child to @context.required"
                                      if can_require_child else
                                      "@context.required has an invalid shape and cannot be synchronized", name)
                    elif isinstance(required, list) and required.count(name) > 1:
                        yield finding(ref, "child-context-required-duplicate", "save-rejected",
                                      f"{path}/properties/@context/required",
                                      "duplicate required entry is not removed by ordinary normalization", name)
                elif state in {"malformed", "unusable"}:
                    yield finding(ref, "unmapped-child-has-unusable-property-iri", "manual-review",
                                  f"{path}/properties/@context/properties/{json_pointer_component(name)}",
                                  "non-serializing child has an unusable mapping that normal minting does not need", value)

            yield from walk(child, actual_path)

    yield from walk(artifact, "")


def is_value_node(node: Any) -> bool:
    """Match the model reader's distinction between a field value and a contextless element."""
    if not isinstance(node, dict) or "@context" in node or "@id" not in node:
        return False
    return bool(node) and set(node).issubset(VALUE_ATOM_KEYS)


def audit_value_ids(ref: ArtifactRef, node: Any, path: str = "", root: bool = True) -> Iterator[Finding]:
    """Classify link/controlled-term IDs by what current readers and persistence actually do."""
    if isinstance(node, dict):
        if not root and is_value_node(node):
            identifier = node.get("@id")
            if identifier is None:
                yield finding(
                    ref, "value-id-null", "save-rejected", f"{path}/@id",
                    "a link or controlled-term value must omit the empty node rather than write a null @id",
                    identifier,
                )
            elif not isinstance(identifier, str):
                yield finding(
                    ref, "value-id-not-string", "save-rejected", f"{path}/@id",
                    "a link or controlled-term @id must be a string",
                    identifier,
                )
            elif not identifier.strip():
                yield finding(
                    ref, "value-id-empty", "reader-blocking", f"{path}/@id",
                    "both current JSON model readers reject an empty link or controlled-term @id",
                    identifier,
                )
            elif not is_well_formed_uri_reference(identifier):
                yield finding(
                    ref, "value-id-malformed", "reader-blocking", f"{path}/@id",
                    "the strict Java reader rejects this malformed URI; no occurrence compatibility applies to "
                    "field values",
                    identifier,
                )
            elif not is_absolute_iri(identifier):
                yield finding(
                    ref, "value-id-relative", "manual-review", f"{path}/@id",
                    "current readers accept this relative URI reference, but it is not an absolute JSON-LD "
                    "identifier and there is no safe automatic repair",
                    identifier,
                )
        for key, value in node.items():
            if key != "@context":
                yield from audit_value_ids(ref, value, f"{path}/{json_pointer_component(key)}", False)
    elif isinstance(node, list):
        for index, value in enumerate(node):
                yield from audit_value_ids(ref, value, f"{path}/{index}", False)


def audit_structural_occurrence_ids(ref: ArtifactRef, node: Any, path: str = "",
                                    root: bool = True) -> Iterator[Finding]:
    """Mirror the server's safe structural fallback when a template cannot be resolved.

    Nested objects with an ``@context`` are occurrence containers. Values inside the context itself
    are skipped, which keeps JSON-LD term definitions out of this traversal.
    """
    if isinstance(node, dict):
        if not root and isinstance(node.get("@context"), dict):
            identifier = node.get("@id")
            if not is_absolute_iri(identifier):
                yield finding(ref, "occurrence-id-unusable", "repair-on-save", f"{path}/@id",
                              "ordinary update mints the occurrence ID; strict readers reject a blank string",
                              identifier)
        for key, value in node.items():
            if key not in {"@context", "@id"}:
                yield from audit_structural_occurrence_ids(
                    ref, value, f"{path}/{json_pointer_component(key)}", False
                )
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from audit_structural_occurrence_ids(ref, value, f"{path}/{index}", False)


def occurrence_id_finding(ref: ArtifactRef, occurrence: Any, path: str) -> Iterator[Finding]:
    if not isinstance(occurrence, dict):
        return
    if not isinstance(occurrence.get("@context"), dict):
        yield finding(ref, "occurrence-context-missing", "save-rejected", f"{path}/@context",
                      "element occurrence has no @context object")
        identifier = occurrence.get("@id")
        if not is_absolute_iri(identifier):
            yield finding(ref, "occurrence-id-unusable", "repair-on-save", f"{path}/@id",
                          "ordinary update mints the occurrence ID; strict readers reject a blank string",
                          identifier)


def audit_attribute_groups(ref: ArtifactRef, instance: dict, shape: SchemaShape,
                           path: str) -> Iterator[Finding]:
    first_group_for_name: dict[str, str] = {}
    valid_names: set[str] = set()
    context = instance.get("@context")

    for group_name in sorted(shape.attribute_groups):
        names = instance.get(group_name)
        if names is None:
            continue
        group_path = f"{path}/{json_pointer_component(group_name)}"
        if not isinstance(names, list):
            yield finding(ref, "attribute-name-list-invalid", "save-rejected", group_path,
                          "attribute-value field must serialize as an array of names", names)
            continue
        seen_in_group: set[str] = set()
        for index, name in enumerate(names):
            name_path = f"{group_path}/{index}"
            if not isinstance(name, str):
                yield finding(ref, "attribute-name-not-string", "save-rejected", name_path,
                              "attribute-value name is not a string", name)
                continue
            if not name.strip():
                yield finding(ref, "attribute-name-blank", "repair-on-save", name_path,
                              "inherited blank attribute name is removed; a new blank is rejected", name)
                continue
            elif name.startswith("@") or name in RESERVED_ATTRIBUTE_VALUE_NAMES:
                yield finding(ref, "attribute-name-reserved", "repair-on-save", name_path,
                              "attribute name is reserved for instance metadata", name)
            elif name in shape.attribute_groups or name in shape.serializing_children:
                yield finding(ref, "attribute-name-child-collision", "repair-on-save", name_path,
                              "attribute name collides with a template child in the same object", name)
            else:
                valid_names.add(name)

            if name in seen_in_group:
                yield finding(ref, "attribute-name-duplicate", "repair-on-save", name_path,
                              f"attribute name occurs more than once in field {group_name!r}", name)
            seen_in_group.add(name)
            first = first_group_for_name.get(name)
            if first is not None and first != group_name:
                yield finding(ref, "attribute-name-duplicate", "repair-on-save", name_path,
                              f"attribute name is also used by field {first!r}", name)
            else:
                first_group_for_name[name] = group_name

    for name in valid_names:
        context_path = f"{path}/@context/{json_pointer_component(name)}"
        mapping = context.get(name) if isinstance(context, dict) else None
        if mapping is None:
            yield finding(ref, "attribute-property-iri-missing",
                          "repair-on-save" if isinstance(context, dict) else "save-rejected", context_path,
                          "ordinary update mints the missing attribute property IRI"
                          if isinstance(context, dict) else
                          "container has no @context object in which normal minting can add the property IRI",
                          name)
        elif not is_absolute_iri(mapping):
            yield finding(ref, "attribute-property-iri-unusable", "manual-review", context_path,
                          "existing attribute mapping is not an absolute IRI and is not safely overwritten", mapping)

    if isinstance(context, dict):
        declared = set(shape.children)
        for term, value in context.items():
            if term.startswith("@") or term in CONTEXT_PREFIXES or term in SYSTEM_CONTEXT_KEYS:
                continue
            if term in instance or term in declared or term in valid_names:
                continue
            if is_repository_property_iri(value):
                yield finding(ref, "orphan-property-iri", "repair-on-save",
                              f"{path}/@context/{json_pointer_component(term)}",
                              "repository-minted context term names neither a value nor a declared child", value)


def audit_instance_with_shape(ref: ArtifactRef, instance: Any, shape: SchemaShape,
                              path: str = "") -> Iterator[Finding]:
    if not isinstance(instance, dict):
        return
    yield from audit_attribute_groups(ref, instance, shape, path)

    for name, child_shape in shape.children.items():
        if name in shape.attribute_groups or name not in instance:
            continue
        value = instance.get(name)
        value_path = f"{path}/{json_pointer_component(name)}"
        if not child_shape.is_element:
            continue
        occurrences = value if isinstance(value, list) else [value]
        for index, occurrence in enumerate(occurrences):
            occurrence_path = f"{value_path}/{index}" if isinstance(value, list) else value_path
            yield from occurrence_id_finding(ref, occurrence, occurrence_path)
            if isinstance(occurrence, dict):
                yield from audit_instance_with_shape(ref, occurrence, child_shape.shape, occurrence_path)


def audit_instance(ref: ArtifactRef, artifact: Any,
                   template_shape: Optional[SchemaShape]) -> Iterator[Finding]:
    if not isinstance(artifact, dict):
        return
    based_on = artifact.get("schema:isBasedOn")
    if not is_absolute_iri(based_on):
        yield finding(ref, "based-on-unusable", "save-rejected", "/schema:isBasedOn",
                      "instance does not name an absolute template IRI", based_on)
    if not isinstance(artifact.get("@context"), dict):
        yield finding(ref, "instance-context-missing", "save-rejected", "/@context",
                      "template instance root has no @context object")
    yield from audit_value_ids(ref, artifact)
    yield from audit_structural_occurrence_ids(ref, artifact)
    if template_shape is None:
        yield finding(ref, "template-analysis-unavailable", "audit-incomplete", "/schema:isBasedOn",
                      "template could not be resolved, so occurrence and attribute-name checks were skipped",
                      based_on)
    else:
        yield from audit_instance_with_shape(ref, artifact, template_shape)


class GetOnlyClient:
    """Small stdlib JSON client whose only public operation is GET."""

    def __init__(self, server: str, api_key: str, timeout: float = 90, retries: int = 5,
                 delay_ms: int = 0, ca_file: Optional[str] = None, allow_http: bool = False):
        self.server = server.rstrip("/")
        parsed = urllib.parse.urlsplit(self.server)
        if parsed.scheme not in ({"https", "http"} if allow_http else {"https"}):
            raise ValueError("--server must use HTTPS (use --allow-http only for a local test server)")
        if (not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValueError("--server must be an origin URL such as https://resource.metadatacenter.org")
        self.origin = (parsed.scheme, parsed.netloc)
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries
        self.delay = max(0, delay_ms) / 1000
        context = ssl.create_default_context(cafile=ca_file) if parsed.scheme == "https" else None
        handlers: list[Any] = [_NoRedirect()]
        if context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.opener = urllib.request.build_opener(*handlers)

    def get_json(self, path: str, query: Optional[dict[str, Any]] = None) -> Any:
        if not path.startswith("/"):
            raise ValueError("request path must start with /")
        url = self.server + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme, parsed.netloc) != self.origin:
            raise ValueError("refusing to send the API key outside the configured origin")
        request = urllib.request.Request(
            url,
            headers={"Authorization": f"apiKey {self.api_key}", "Accept": "application/json"},
            method="GET",
        )
        for attempt in range(self.retries):
            if self.delay:
                time.sleep(self.delay)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    raise AuthenticationError(
                        "401 Unauthorized; check CEDAR_API_KEY (sent with the CEDAR apiKey scheme)"
                    ) from None
                if error.code in {301, 302, 303, 307, 308}:
                    raise ResponseError(
                        f"refusing redirect from {url}; configure the final resource-server origin"
                    ) from None
                if error.code in {429, 500, 502, 503, 504} and attempt < self.retries - 1:
                    retry_after = error.headers.get("Retry-After")
                    try:
                        wait = min(60.0, float(retry_after)) if retry_after else min(30.0, 2 ** attempt)
                    except ValueError:
                        wait = min(30.0, 2 ** attempt)
                    time.sleep(wait)
                    continue
                body = error.read(300).decode("utf-8", errors="replace")
                raise ResponseError(f"GET {url} returned {error.code}: {body}") from None
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                if attempt < self.retries - 1:
                    time.sleep(min(30.0, 2 ** attempt))
                    continue
                raise ResponseError(f"GET {url} failed: {type(error).__name__}: {error}") from None
        raise ResponseError(f"GET {url} exhausted its retry budget")


def typed_artifact_path(ref: ArtifactRef) -> str:
    return f"/{ARTIFACT_PATHS[ref.artifact_type]}/{urllib.parse.quote(ref.artifact_id, safe='')}"


def search_deep_page(client: GetOnlyClient, artifact_type: str, limit: int, offset: Optional[int] = None,
                     continuation: Optional[str] = None) -> dict[str, Any]:
    """One page, asked for either by offset or by where the previous page stopped.

    The two are mutually exclusive: a server that serves continuations refuses a request carrying both.
    """
    parameters: dict[str, Any] = {
        "resource_types": artifact_type,
        "version": "all",
        "publication_status": "all",
        "sort": "createdOnTS,name",
        "limit": limit,
    }
    if continuation is not None:
        parameters["continuation"] = continuation
    else:
        parameters["offset"] = offset or 0
    data = client.get_json("/search-deep", parameters)
    if (not isinstance(data, dict) or not isinstance(data.get("resources"), list)
            or not isinstance(data.get("totalCount"), int) or data["totalCount"] < 0):
        raise ResponseError(f"search-deep returned an unexpected body for {artifact_type}")
    return data


def preflight_expected_counts(client: GetOnlyClient, artifact_types: list[str], state: AuditState) -> None:
    """Read every selected total before fetching artifacts so progress has a denominator from item one."""
    for artifact_type in artifact_types:
        data = search_deep_page(client, artifact_type, 1, 0)
        state.expected_by_type[artifact_type] = data["totalCount"]


def iter_artifact_refs(client: GetOnlyClient, artifact_type: str, page_size: int,
                       state: AuditState, hard_limit: Optional[int] = None) -> Iterator[ArtifactRef]:
    """Every artifact of one type the key can enumerate, in one pass over the search index.

    Pages are asked for by continuation: each answer says where it stopped and the next resumes there,
    so a page costs one request rather than one request plus the offset in front of it. The pass also
    reads a single snapshot of the index, so a row created or deleted while it runs cannot shift a
    later page onto rows an earlier one already returned.

    A server too old to serve continuations ignores the parameter and answers by offset. Its first
    answer carries no continuation while reporting more rows than it returned, which is what the pass
    falls back on: the sort is stable, so it carries on by offset from where the first page ended.
    """
    expected: Optional[int] = state.expected_by_type.get(artifact_type)
    seen: set[str] = set()
    page_signatures: set[tuple[str, ...]] = set()
    continuation: Optional[str] = SEARCH_CONTINUATION_START
    offset = 0
    mode = "continuation"
    first_page = True

    while True:
        if continuation is not None:
            data = search_deep_page(client, artifact_type, page_size, continuation=continuation)
        else:
            data = search_deep_page(client, artifact_type, page_size, offset=offset)
        resources = data.get("resources") or []
        total = data.get("totalCount")
        if total != expected:
            state.total_count_changes.append({
                "artifactType": artifact_type,
                "position": "continuation" if continuation is not None else offset,
                "was": expected, "now": total,
            })
            expected = total
            state.expected_by_type[artifact_type] = total

        next_continuation = data.get("continuation")
        if not isinstance(next_continuation, str) or not next_continuation:
            next_continuation = None
        if first_page and next_continuation is None and isinstance(total, int) and total > len(resources):
            # A walk that ends on its first page reports every row it has. This one reported more, so
            # the parameter went unread and the rest of the pass has to ask by offset.
            mode = "offset"
        first_page = False

        if not resources:
            break

        signature = tuple(str(resource.get("@id")) for resource in resources if isinstance(resource, dict))
        if signature in page_signatures:
            raise ResponseError(
                f"search-deep repeated a page for {artifact_type}; stopping to avoid a loop"
            )
        page_signatures.add(signature)

        for resource in resources:
            if not isinstance(resource, dict):
                state.listing_errors += 1
                continue
            artifact_id = resource.get("@id")
            if not isinstance(artifact_id, str) or not artifact_id:
                state.listing_errors += 1
                continue
            if artifact_id in seen:
                state.duplicates += 1
                continue
            seen.add(artifact_id)
            name = resource.get("schema:name") or resource.get("schema:title") or ""
            yield ArtifactRef(artifact_type, artifact_id, str(name))
            if hard_limit is not None and len(seen) >= hard_limit:
                # A sample stops early and walks away from the rest. Nothing needs releasing: the
                # snapshot the server holds for an abandoned walk expires on its own.
                state.pagination_by_type[artifact_type] = mode
                return

        if mode == "continuation":
            continuation = next_continuation
            if continuation is None:
                break
        else:
            continuation = None
            offset += len(resources)
            if expected is not None and offset >= expected:
                break

    state.pagination_by_type[artifact_type] = mode

    if hard_limit is None and expected is not None and len(seen) != expected:
        state.listing_errors += 1
        print(
            f"! search-deep enumerated {len(seen)} unique {artifact_type} rows but reported {expected}",
            file=sys.stderr,
        )


def top_counts(counter: collections.Counter, limit: int = 4) -> str:
    if not counter:
        return "none"
    return ", ".join(f"{name}={count}" for name, count in counter.most_common(limit))


def completion_percent(processed: int, total: int) -> float:
    if total <= 0:
        return 100.0 if processed == 0 else 0.0
    return min(100.0, processed * 100.0 / total)


def format_duration(seconds: float) -> str:
    rounded = max(0, int(round(seconds)))
    hours, remainder = divmod(rounded, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def print_progress(state: AuditState, final: bool = False) -> None:
    start = state.batch_start + 1 if state.processed > state.batch_start else state.processed
    label = "final" if final else "checkpoint"
    type_summary = ", ".join(f"{kind}={count}" for kind, count in state.batch_per_type.items()) or "none"
    total = state.planned_total
    percent = completion_percent(state.processed, total)
    elapsed = state.elapsed_seconds
    processing_elapsed = state.processing_elapsed_seconds
    timing = f"elapsed={format_duration(elapsed)}"
    if not final and state.processed and state.processed < total and processing_elapsed > 0:
        eta = (total - state.processed) / (state.processed / processing_elapsed)
        timing += f", eta={format_duration(eta)}"
    print(
        f"[{label} {state.processed}/{total} {percent:.1f}%] batch {start}-{state.processed}: "
        f"types({type_summary}); affected={len(state.batch_affected)} batch/{len(state.affected_artifacts)} total; "
        f"findings={sum(state.batch_findings.values())} ({top_counts(state.batch_findings)}); "
        f"risks({top_counts(state.batch_risks)}); fetch-errors={state.batch_fetch_errors}; {timing}",
        flush=True,
    )


def summary_document(state: AuditState, status: str, server: str, types: list[str],
                     findings_path: str, refs_path: str) -> dict[str, Any]:
    total = state.planned_total
    return {
        "auditRuleset": {
            "version": AUDIT_RULESET_VERSION,
            "scriptSha256": script_sha256(),
            "behavioralBaselines": BEHAVIORAL_BASELINES,
        },
        "status": status,
        "startedAt": state.started_at,
        "updatedAt": utc_now(),
        "elapsedSeconds": round(state.elapsed_seconds, 3),
        "server": server,
        "scope": {
            "artifactTypes": types,
            "selectedArtifactTotal": state.planned_total,
            "searchReportedTotal": state.expected_total,
            "permissionScoped": True,
            "statement": "Complete means all artifacts enumerated and readable by this API key, not store-wide completeness.",
            "httpMethods": ["GET"],
        },
        "completion": {
            "processed": state.processed,
            "target": total,
            "percent": round(completion_percent(state.processed, total), 3),
        },
        "artifactsProcessed": state.processed,
        "artifactsFetched": state.fetched,
        "processedByType": dict(state.processed_by_type),
        "fetchedByType": dict(state.fetched_by_type),
        "expectedByType": state.expected_by_type,
        "enumeratedByType": state.enumerated_by_type,
        "paginationByType": state.pagination_by_type,
        "affectedArtifacts": len(state.affected_artifacts),
        "affectedArtifactsByType": {
            key: len(values) for key, values in sorted(state.affected_by_type.items())
        },
        "affectedArtifactsByRule": {
            key: len(values) for key, values in sorted(state.affected_by_rule.items())
        },
        "affectedArtifactsByRisk": {
            key: len(values) for key, values in sorted(state.affected_by_risk.items())
        },
        "findings": sum(state.finding_counts.values()),
        "findingsByRule": dict(state.finding_counts),
        "findingsByRisk": dict(state.risk_counts),
        "findingsByType": dict(state.findings_by_type),
        "fetchErrors": state.fetch_errors,
        "listingErrors": state.listing_errors,
        "unresolvedTemplates": state.unresolved_templates,
        "duplicateSearchRowsSkipped": state.duplicates,
        "searchTotalCountChanges": state.total_count_changes,
        "fetchErrorDetails": state.fetch_error_details,
        "unresolvedTemplateDetails": state.unresolved_template_details,
        "findingsFile": findings_path,
        "refsFile": refs_path,
    }


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def open_private_text_file(path: Path, append: bool = False):
    """Open a streamed report as owner-only and refuse a symlink where the platform supports it."""
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_TRUNC)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    return os.fdopen(descriptor, "a" if append else "w", encoding="utf-8")


def artifact_key(ref: ArtifactRef) -> tuple[str, str]:
    return ref.artifact_type, ref.artifact_id


def refs_manifest_document(arguments: argparse.Namespace, state: AuditState,
                           artifact_refs: list[ArtifactRef]) -> dict[str, Any]:
    return {
        "record": "audit-ref-manifest",
        "formatVersion": REFS_FORMAT_VERSION,
        "server": arguments.server,
        "artifactTypes": arguments.selected_types,
        "limit": arguments.limit,
        "auditRulesetVersion": AUDIT_RULESET_VERSION,
        "scriptSha256": script_sha256(),
        "startedAt": state.started_at,
        "expectedByType": state.expected_by_type,
        "enumeratedByType": state.enumerated_by_type,
        "paginationByType": state.pagination_by_type,
        "listingErrors": state.listing_errors,
        "duplicateSearchRowsSkipped": state.duplicates,
        "searchTotalCountChanges": state.total_count_changes,
        "artifactRefCount": len(artifact_refs),
    }


def write_refs_manifest(path: Path, arguments: argparse.Namespace, state: AuditState,
                        artifact_refs: list[ArtifactRef]) -> None:
    with open_private_text_file(path) as stream:
        stream.write(json.dumps(refs_manifest_document(arguments, state, artifact_refs),
                                ensure_ascii=False) + "\n")
        for ref in artifact_refs:
            stream.write(json.dumps({
                "record": "artifact-ref",
                "artifactType": ref.artifact_type,
                "artifactId": ref.artifact_id,
                "artifactName": ref.name,
            }, ensure_ascii=False) + "\n")
        stream.flush()


def load_refs_manifest(path: Path, arguments: argparse.Namespace, parser: argparse.ArgumentParser
                       ) -> tuple[dict[str, Any], list[ArtifactRef], dict[tuple[str, str], bool]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read resume refs file {path}: {error}")
    if not lines:
        parser.error(f"resume refs file is empty: {path}")
    try:
        records = [json.loads(line) for line in lines]
    except json.JSONDecodeError as error:
        parser.error(f"resume refs file is not valid JSONL: {path}:{error.lineno}: {error.msg}")
    manifest = records[0]
    if not isinstance(manifest, dict) or manifest.get("record") != "audit-ref-manifest":
        parser.error(f"resume refs file has no audit-ref-manifest header: {path}")
    expected = {
        "formatVersion": REFS_FORMAT_VERSION,
        "server": arguments.server,
        "artifactTypes": arguments.selected_types,
        "limit": arguments.limit,
        "auditRulesetVersion": AUDIT_RULESET_VERSION,
        "scriptSha256": script_sha256(),
    }
    mismatches = [name for name, value in expected.items() if manifest.get(name) != value]
    if mismatches:
        parser.error("resume refs file does not match this invocation: " + ", ".join(mismatches))

    refs: list[ArtifactRef] = []
    completed: dict[tuple[str, str], bool] = {}
    for record in records[1:]:
        if not isinstance(record, dict):
            parser.error(f"resume refs file contains a non-object record: {path}")
        if record.get("record") == "artifact-ref":
            refs.append(ArtifactRef(
                str(record.get("artifactType", "")),
                str(record.get("artifactId", "")),
                str(record.get("artifactName", "")),
            ))
        elif record.get("record") == "artifact-complete":
            completed[(str(record.get("artifactType", "")), str(record.get("artifactId", "")))] = \
                bool(record.get("fetched"))
        else:
            parser.error(f"resume refs file contains an unknown record type: {path}")
    if len(refs) != manifest.get("artifactRefCount"):
        parser.error(f"resume refs file is incomplete: expected {manifest.get('artifactRefCount')} refs, "
                     f"found {len(refs)}")
    if len({artifact_key(ref) for ref in refs}) != len(refs):
        parser.error(f"resume refs file contains duplicate artifact refs: {path}")
    if set(completed) - {artifact_key(ref) for ref in refs}:
        parser.error(f"resume refs file contains completions for unknown artifacts: {path}")
    return manifest, refs, completed


def load_existing_findings(path: Path, parser: argparse.ArgumentParser) -> list[Finding]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read findings file for --resume: {error}")
    findings: list[Finding] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            findings.append(Finding(**record))
        except (json.JSONDecodeError, TypeError) as error:
            parser.error(f"invalid finding in {path}:{line_number}: {error}")
    return findings


def restore_resume_state(arguments: argparse.Namespace, manifest: dict[str, Any],
                         findings: list[Finding], completed: dict[tuple[str, str], bool]) -> AuditState:
    state = AuditState(limit=arguments.limit, started_at=str(manifest["startedAt"]))
    state.expected_by_type.update(manifest.get("expectedByType", {}))
    state.enumerated_by_type.update(manifest.get("enumeratedByType", {}))
    state.listing_errors = int(manifest.get("listingErrors", 0))
    state.duplicates = int(manifest.get("duplicateSearchRowsSkipped", 0))
    state.total_count_changes.extend(manifest.get("searchTotalCountChanges", []))
    state.enumeration_complete = True
    diagnostics = {"artifact-fetch-failed", "template-resolution-failed"}
    for item in findings:
        if item.rule in diagnostics:
            state.add_diagnostic(item)
        else:
            state.add_findings(ArtifactRef(item.artifact_type, item.artifact_id, item.artifact_name), [item])
        if item.rule == "artifact-fetch-failed":
            state.fetch_errors += 1
            state.fetch_error_details.append({
                "artifactType": item.artifact_type,
                "artifactId": item.artifact_id,
                "artifactName": item.artifact_name,
                "error": item.message,
            })
        elif item.rule == "template-resolution-failed":
            state.unresolved_templates += 1
            state.unresolved_template_details.append({
                "instanceId": item.artifact_id,
                "templateId": item.value,
                "error": item.message,
            })
    for (artifact_type, _artifact_id), fetched in completed.items():
        state.artifact_processed(artifact_type, fetched)
    state.reset_batch()
    return state


def resolve_api_key(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> str:
    if arguments.api_key_file:
        try:
            key = Path(arguments.api_key_file).read_text(encoding="utf-8").strip()
        except OSError as error:
            parser.error(f"cannot read --api-key-file: {error}")
    else:
        key = os.environ.get("CEDAR_API_KEY", "").strip()
    if not key and sys.stdin.isatty():
        key = getpass.getpass("CEDAR API key: ").strip()
    if not key:
        parser.error("set CEDAR_API_KEY, use --api-key-file, or run interactively to be prompted")
    if "\n" in key or "\r" in key:
        parser.error("API key must be one line")
    return key


def parse_types(value: str, parser: argparse.ArgumentParser) -> list[str]:
    types = [item.strip() for item in value.split(",") if item.strip()]
    if not types:
        parser.error("--types must select at least one artifact type")
    if types == ["all"]:
        return list(TYPE_ORDER)
    if "all" in types:
        parser.error("--types all must be used on its own")
    unknown = set(types) - set(ARTIFACT_PATHS)
    if unknown:
        parser.error(f"unknown artifact types {sorted(unknown)}; choose from {list(TYPE_ORDER)}")
    return [kind for kind in TYPE_ORDER if kind in types]


def run_audit(arguments: argparse.Namespace, client: GetOnlyClient,
              findings_stream, summary_path: Path, refs_path: Path) -> tuple[AuditState, str]:
    state = arguments.resume_state if arguments.resume else AuditState(limit=arguments.limit)
    completed: dict[tuple[str, str], bool] = arguments.completed if arguments.resume else {}
    template_shapes: dict[str, SchemaShape] = {}
    status = "RUNNING"

    def checkpoint() -> None:
        print_progress(state)
        atomic_write_json(
            summary_path,
            summary_document(state, "RUNNING", arguments.server, arguments.selected_types,
                             str(arguments.out), str(refs_path)),
        )
        state.reset_batch()

    def write_diagnostic(diagnostic: Finding) -> None:
        state.add_diagnostic(diagnostic)
        findings_stream.write(json.dumps(diagnostic.json_record(), ensure_ascii=False) + "\n")
        findings_stream.flush()

    try:
        if arguments.resume:
            artifact_refs = arguments.artifact_refs
            print(f"Resuming from {refs_path}: {len(completed)}/{len(artifact_refs)} artifacts already complete",
                  flush=True)
        else:
            preflight_expected_counts(client, arguments.selected_types, state)
            reported_counts = ", ".join(
                f"{kind}={state.expected_by_type[kind]}" for kind in arguments.selected_types
            )
            print(f"Search reports: {state.expected_total} rows ({reported_counts}); enumerating unique IDs",
                  flush=True)

            artifact_refs = []
            for artifact_type in arguments.selected_types:
                remaining = None if arguments.limit is None else max(0, arguments.limit - len(artifact_refs))
                if remaining == 0:
                    break
                refs = list(iter_artifact_refs(client, artifact_type, arguments.page_size, state, remaining))
                state.enumerated_by_type[artifact_type] = len(refs)
                artifact_refs.extend(refs)
            state.enumeration_complete = True
            write_refs_manifest(refs_path, arguments, state, artifact_refs)
        selected_counts = ", ".join(
            f"{kind}={state.enumerated_by_type.get(kind, 0)}" for kind in arguments.selected_types
        )
        limit_note = f"; sample limit={arguments.limit}" if arguments.limit is not None else ""
        print(
            f"Audit total: {state.planned_total} unique artifacts ({selected_counts}){limit_note}",
            flush=True,
        )
        atomic_write_json(
            summary_path,
            summary_document(state, "RUNNING", arguments.server, arguments.selected_types,
                             str(arguments.out), str(refs_path)),
        )
        state.processing_started_monotonic = time.monotonic()
        with open_private_text_file(refs_path, append=True) as refs_stream:
            for ref in artifact_refs:
                if artifact_key(ref) in completed:
                    continue
                artifact_type = ref.artifact_type
                try:
                    artifact = client.get_json(typed_artifact_path(ref))
                except AuthenticationError:
                    raise
                except Exception as error:
                    state.fetch_errors += 1
                    state.batch_fetch_errors += 1
                    error_text = str(error)
                    state.fetch_error_details.append({
                        "artifactType": ref.artifact_type,
                        "artifactId": ref.artifact_id,
                        "artifactName": ref.name,
                        "error": error_text,
                    })
                    write_diagnostic(finding(
                        ref,
                        "artifact-fetch-failed",
                        "audit-incomplete",
                        "/",
                        f"full artifact could not be fetched: {error_text}",
                    ))
                    print(f"! could not fetch {ref.artifact_type} {ref.artifact_id}: {error}", file=sys.stderr)
                    state.artifact_processed(artifact_type, fetched=False)
                    completed[artifact_key(ref)] = False
                    refs_stream.write(json.dumps({
                        "record": "artifact-complete", "artifactType": ref.artifact_type,
                        "artifactId": ref.artifact_id, "fetched": False,
                    }, ensure_ascii=False) + "\n")
                    refs_stream.flush()
                    if state.processed % arguments.progress_every == 0:
                        checkpoint()
                    continue

                findings = list(audit_common(ref, artifact))
                diagnostics: list[Finding] = []
                if artifact_type in {"template", "element"}:
                    findings.extend(audit_schema(ref, artifact))
                    if artifact_type == "template" and isinstance(artifact, dict):
                        body_id = artifact.get("@id")
                        template_shapes[ref.artifact_id] = build_schema_shape(artifact)
                        if isinstance(body_id, str):
                            template_shapes[body_id] = template_shapes[ref.artifact_id]
                elif artifact_type == "instance":
                    based_on = artifact.get("schema:isBasedOn") if isinstance(artifact, dict) else None
                    shape = template_shapes.get(based_on) if isinstance(based_on, str) else None
                    if shape is None and is_absolute_iri(based_on):
                        template_ref = ArtifactRef("template", based_on)
                        try:
                            template = client.get_json(typed_artifact_path(template_ref))
                            shape = build_schema_shape(template)
                            template_shapes[based_on] = shape
                        except AuthenticationError:
                            raise
                        except Exception as error:
                            state.unresolved_templates += 1
                            error_text = str(error)
                            state.unresolved_template_details.append({
                                "instanceId": ref.artifact_id,
                                "templateId": based_on,
                                "error": error_text,
                            })
                            diagnostics.append(finding(
                                ref,
                                "template-resolution-failed",
                                "audit-incomplete",
                                "/schema:isBasedOn",
                                f"referenced template could not be fetched: {error_text}",
                                based_on,
                            ))
                            print(f"! could not resolve template {based_on} for {ref.artifact_id}: {error}",
                                  file=sys.stderr)
                    findings.extend(audit_instance(ref, artifact, shape))

                for diagnostic in diagnostics:
                    state.add_diagnostic(diagnostic)
                output = "".join(
                    json.dumps(item.json_record(), ensure_ascii=False) + "\n"
                    for item in [*diagnostics, *state.add_findings(ref, findings)]
                )
                if output:
                    findings_stream.write(output)
                findings_stream.flush()
                state.artifact_processed(artifact_type, fetched=True)
                completed[artifact_key(ref)] = True
                refs_stream.write(json.dumps({
                    "record": "artifact-complete", "artifactType": ref.artifact_type,
                    "artifactId": ref.artifact_id, "fetched": True,
                }, ensure_ascii=False) + "\n")
                refs_stream.flush()
                if state.processed % arguments.progress_every == 0:
                    checkpoint()

        if state.fetch_errors or state.listing_errors or state.unresolved_templates:
            status = "PARTIAL_ERRORS"
        elif state.total_count_changes or state.duplicates:
            status = "PARTIAL_CONCURRENT_CHANGES"
        elif arguments.limit is not None and state.processed >= arguments.limit:
            status = f"SAMPLE_LIMIT_{arguments.limit}"
        else:
            status = "COMPLETE_FOR_KEY"
    except KeyboardInterrupt:
        status = "PARTIAL_INTERRUPTED"
    except AuthenticationError as error:
        status = "PARTIAL_AUTHENTICATION_ERROR"
        print(f"! {error}", file=sys.stderr)
    except Exception as error:
        status = f"PARTIAL_{type(error).__name__.upper()}"
        state.listing_errors += 1
        print(f"! audit stopped: {type(error).__name__}: {error}", file=sys.stderr)
    finally:
        if state.processed > state.batch_start or state.processed == 0:
            print_progress(state, final=True)
        atomic_write_json(
            summary_path,
            summary_document(state, status, arguments.server, arguments.selected_types,
                             str(arguments.out), str(refs_path)),
        )
    return state, status


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="GET-only audit of artifacts against hardened CEDAR minting requirements.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The JSONL contains findings only; full artifacts and the API key are never written. "
            "A COMPLETE_FOR_KEY result is permission-scoped and does not prove Mongo/graph parity."
        ),
    )
    parser.add_argument("--server", default=DEFAULT_SERVER,
                        help=f"resource server origin (default: {DEFAULT_SERVER})")
    parser.add_argument("--api-key-file",
                        help="read the API key from this one-line file; otherwise CEDAR_API_KEY or a prompt")
    parser.add_argument("--types", default=",".join(DEFAULT_TYPES),
                        help="comma-separated artifact types or all (default: template,element)")
    parser.add_argument("--page-size", type=int, default=100,
                        help="search-deep page size (default: 100)")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help="print and checkpoint a brief summary every N processed artifacts (default: 300)")
    parser.add_argument("--limit", type=int, help="quick sample: stop after this many artifacts total")
    parser.add_argument("--out", default="cedar-artifact-audit-findings.jsonl",
                        help="stream findings as JSONL (default: cedar-artifact-audit-findings.jsonl)")
    parser.add_argument("--summary",
                        help="summary JSON path (default: <out without suffix>-summary.json)")
    parser.add_argument("--refs",
                        help="enumerated refs/checkpoint JSONL path (default: <out without suffix>-refs.jsonl)")
    parser.add_argument("--resume", action="store_true",
                        help="resume from --refs and append to the existing findings JSONL")
    parser.add_argument("--timeout", type=float, default=90,
                        help="per-request timeout in seconds (default: 90)")
    parser.add_argument("--retries", type=int, default=5,
                        help="attempts for transient failures (default: 5)")
    parser.add_argument("--delay-ms", type=int, default=0,
                        help="polite delay before every request (default: 0)")
    parser.add_argument("--ca-file", help="additional CA bundle for a trusted private HTTPS deployment")
    parser.add_argument("--allow-http", action="store_true",
                        help="allow plain HTTP; intended only for a local test server")
    parser.add_argument("--fail-on-findings", action="store_true",
                        help="exit 1 after a complete run when findings exist")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.page_size <= 0:
        parser.error("--page-size must be positive")
    if arguments.progress_every <= 0:
        parser.error("--progress-every must be positive")
    if arguments.limit is not None and arguments.limit <= 0:
        parser.error("--limit must be positive")
    if arguments.retries <= 0:
        parser.error("--retries must be positive")
    if arguments.timeout <= 0:
        parser.error("--timeout must be positive")
    arguments.selected_types = parse_types(arguments.types, parser)
    api_key = resolve_api_key(arguments, parser)

    findings_path = Path(arguments.out).expanduser()
    summary_path = Path(arguments.summary).expanduser() if arguments.summary else \
        findings_path.with_name(findings_path.stem + "-summary.json")
    refs_path = Path(arguments.refs).expanduser() if arguments.refs else \
        findings_path.with_name(findings_path.stem + "-refs.jsonl")
    resolved_paths = {findings_path.resolve(), summary_path.resolve(), refs_path.resolve()}
    if len(resolved_paths) != 3:
        parser.error("--out, --summary, and --refs must name different files")
    arguments.out = str(findings_path)
    arguments.server = arguments.server.rstrip("/")
    findings_path.parent.mkdir(parents=True, exist_ok=True)
    refs_path.parent.mkdir(parents=True, exist_ok=True)

    if arguments.resume:
        manifest, artifact_refs, completed = load_refs_manifest(refs_path, arguments, parser)
        existing_findings = load_existing_findings(findings_path, parser)
        findings_by_key: dict[tuple[str, str], list[Finding]] = collections.defaultdict(list)
        for item in existing_findings:
            findings_by_key[(item.artifact_type, item.artifact_id)].append(item)
        known_refs = {artifact_key(ref) for ref in artifact_refs}
        if set(findings_by_key) - known_refs:
            parser.error("findings file contains artifact IDs absent from the resume refs file")
        for key, items in findings_by_key.items():
            completed.setdefault(key, not any(item.rule == "artifact-fetch-failed" for item in items))
        arguments.artifact_refs = artifact_refs
        arguments.completed = completed
        arguments.resume_state = restore_resume_state(arguments, manifest, existing_findings, completed)

    try:
        client = GetOnlyClient(
            arguments.server,
            api_key,
            timeout=arguments.timeout,
            retries=arguments.retries,
            delay_ms=arguments.delay_ms,
            ca_file=arguments.ca_file,
            allow_http=arguments.allow_http,
        )
    except (ValueError, OSError) as error:
        parser.error(str(error))

    print(f"GET-only audit of {arguments.server}")
    print(f"Ruleset: {AUDIT_RULESET_VERSION}")
    print(f"Scope: {', '.join(arguments.selected_types)}; permission-scoped to this key")
    print(f"Findings: {findings_path}; summary: {summary_path}; refs: {refs_path}")
    print("Mode: resume (append findings, reuse enumerated refs)" if arguments.resume else "Mode: new audit")
    print(f"Progress checkpoint: every {arguments.progress_every} artifacts")

    try:
        with open_private_text_file(findings_path, append=arguments.resume) as findings_stream:
            state, status = run_audit(arguments, client, findings_stream, summary_path, refs_path)
    except OSError as error:
        parser.error(f"cannot open findings file securely: {error}")

    print("\n=== Final summary ===")
    print(f"status: {status}")
    print(f"artifacts: processed={state.processed}/{state.planned_total}, fetched={state.fetched} "
          f"({', '.join(f'{k}={v}' for k, v in state.fetched_by_type.items()) or 'none'})")
    print(f"affected artifacts: {len(state.affected_artifacts)}")
    print(f"findings: {sum(state.finding_counts.values())} ({top_counts(state.finding_counts, 8)})")
    print(f"risks: {top_counts(state.risk_counts, 8)}")
    print(f"fetch/listing errors: {state.fetch_errors}/{state.listing_errors}; "
          f"unresolved templates: {state.unresolved_templates}")
    print(f"details: {findings_path}")
    print(f"summary: {summary_path}")
    print("No artifact writes were issued; the HTTP client supports GET only.")

    if status.startswith("PARTIAL"):
        return 2
    if arguments.fail_on_findings and state.finding_counts:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
