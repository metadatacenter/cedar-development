#!/usr/bin/env python3
"""Read-only REST audit for artifacts affected by CEDAR's hardened minting rules.

The auditor enumerates every template, element, field, and instance visible to one API key through
``/search-deep`` and fetches each full artifact through its typed resource endpoint. It issues GET
requests only. Findings are streamed as JSONL, a machine-readable summary is checkpointed every 300
artifacts by default, and a concise progress line is printed at the same interval.

Enumeration is permission-scoped: "complete" means complete for what the supplied key can read and
what the resource server's graph can enumerate. It is not a substitute for a store query when the key
cannot see the entire deployment or when the graph and artifact store have drifted.

Keep credentials out of shell history and the process list:

    export CEDAR_API_KEY=...
    python3 ops/cedar_artifact_rest_audit.py \
      --server https://resource.metadatacenter.org \
      --out production-artifact-findings.jsonl

No third-party packages are required.
"""

from __future__ import annotations

import argparse
import collections
import getpass
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
ARTIFACT_PATHS = {
    "template": "templates",
    "element": "template-elements",
    "field": "template-fields",
    "instance": "template-instances",
}
TYPE_ORDER = ("template", "element", "field", "instance")

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
    started_at: str = field(default_factory=lambda: utc_now())
    processed: int = 0
    fetched: int = 0
    processed_by_type: collections.Counter = field(default_factory=collections.Counter)
    fetched_by_type: collections.Counter = field(default_factory=collections.Counter)
    affected_artifacts: set[tuple[str, str]] = field(default_factory=set)
    finding_counts: collections.Counter = field(default_factory=collections.Counter)
    risk_counts: collections.Counter = field(default_factory=collections.Counter)
    fetch_errors: int = 0
    listing_errors: int = 0
    unresolved_templates: int = 0
    duplicates: int = 0
    expected_by_type: dict[str, int] = field(default_factory=dict)
    total_count_changes: list[dict[str, Any]] = field(default_factory=list)
    batch_start: int = 0
    batch_per_type: collections.Counter = field(default_factory=collections.Counter)
    batch_affected: set[tuple[str, str]] = field(default_factory=set)
    batch_findings: collections.Counter = field(default_factory=collections.Counter)
    batch_fetch_errors: int = 0

    def add_findings(self, ref: ArtifactRef, findings: Iterable[Finding]) -> list[Finding]:
        found = list(findings)
        if found:
            key = (ref.artifact_type, ref.artifact_id)
            self.affected_artifacts.add(key)
            self.batch_affected.add(key)
        for finding in found:
            self.finding_counts[finding.rule] += 1
            self.risk_counts[finding.risk] += 1
            self.batch_findings[finding.rule] += 1
        return found

    def artifact_processed(self, artifact_type: str, fetched: bool) -> None:
        self.processed += 1
        self.processed_by_type[artifact_type] += 1
        self.batch_per_type[artifact_type] += 1
        if fetched:
            self.fetched += 1
            self.fetched_by_type[artifact_type] += 1

    def reset_batch(self) -> None:
        self.batch_start = self.processed
        self.batch_per_type.clear()
        self.batch_affected.clear()
        self.batch_findings.clear()
        self.batch_fetch_errors = 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_pointer_component(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def child_path(parent: str, name: str) -> str:
    return f"{parent}/properties/{json_pointer_component(name)}"


def is_absolute_iri(value: Any) -> bool:
    """Mirror the hardened Java boundary closely enough for a read-only static audit."""
    if not isinstance(value, str) or not value or value.isspace() or value != value.strip():
        return False
    if any(ch.isspace() or ord(ch) < 0x20 for ch in value):
        return False
    if re.search(r"%(?![0-9A-Fa-f]{2})|[<>\"{}|\\^`]", value):
        return False
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return bool(parsed.scheme) and bool(URI_SCHEME.match(value))


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
            if node.get("pav:derivedFrom") == "":
                yield finding(ref, "derived-from-empty", "reader-blocking",
                              f"{path}/pav:derivedFrom", "strict model readers reject an empty pav:derivedFrom", "")
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

            at_type = child.get("@type")
            if at_type not in RECOGNISED_CHILD_TYPES:
                yield finding(ref, "child-type-unrecognised", "save-rejected", f"{actual_path}/@type",
                              "child must declare TemplateElement, TemplateField, or StaticTemplateField", at_type)

            identifier = child.get("@id")
            if not is_absolute_iri(identifier):
                yield finding(ref, "child-id-unusable", "repair-on-save", f"{actual_path}/@id",
                              "ordinary update mints a child ID; verbatim update rejects this value", identifier)
            elif mismatched_child_prefix(identifier, at_type):
                yield finding(ref, "child-id-prefix-mismatch", "manual-review", f"{actual_path}/@id",
                              "child ID prefix contradicts @type and is deliberately not rewritten automatically",
                              identifier)

            ui = child.get("_ui")
            if isinstance(ui, dict):
                input_type = ui.get("inputType") if isinstance(ui.get("inputType"), str) else ""
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


def audit_value_ids(ref: ArtifactRef, node: Any, path: str = "", root: bool = True) -> Iterator[Finding]:
    """Find unusable link/controlled-term IDs without confusing element occurrences with values."""
    if isinstance(node, dict):
        if not root and "@context" not in node and "@id" in node:
            identifier = node.get("@id")
            if isinstance(identifier, str) and not is_absolute_iri(identifier):
                yield finding(ref, "value-id-unusable", "reader-blocking", f"{path}/@id",
                              "blank or relative link/controlled-term @id is not covered by occurrence compatibility",
                              identifier)
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


def iter_artifact_refs(client: GetOnlyClient, artifact_type: str, page_size: int,
                       state: AuditState, hard_limit: Optional[int] = None) -> Iterator[ArtifactRef]:
    offset = 0
    expected: Optional[int] = None
    seen: set[str] = set()
    page_signatures: set[tuple[str, ...]] = set()
    while True:
        data = client.get_json("/search-deep", {
            "resource_types": artifact_type,
            "version": "all",
            "publication_status": "all",
            "sort": "createdOnTS,name",
            "limit": page_size,
            "offset": offset,
        })
        if not isinstance(data, dict) or not isinstance(data.get("resources"), list):
            raise ResponseError(f"search-deep returned an unexpected body for {artifact_type}")
        resources = data.get("resources") or []
        total = data.get("totalCount")
        if isinstance(total, int):
            if expected is None:
                expected = total
                state.expected_by_type[artifact_type] = total
            elif total != expected:
                state.total_count_changes.append({
                    "artifactType": artifact_type, "offset": offset, "was": expected, "now": total,
                })
                expected = total
                state.expected_by_type[artifact_type] = total
        if not resources:
            break

        signature = tuple(str(resource.get("@id")) for resource in resources if isinstance(resource, dict))
        if signature in page_signatures:
            raise ResponseError(
                f"search-deep repeated a page for {artifact_type} at offset {offset}; stopping to avoid a loop"
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
                return

        offset += page_size
        if expected is not None and offset >= expected:
            break

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


def print_progress(state: AuditState, final: bool = False) -> None:
    start = state.batch_start + 1 if state.processed > state.batch_start else state.processed
    label = "final" if final else "checkpoint"
    type_summary = ", ".join(f"{kind}={count}" for kind, count in state.batch_per_type.items()) or "none"
    print(
        f"[{label} {state.processed}] artifacts {start}-{state.processed}: "
        f"types({type_summary}); affected={len(state.batch_affected)}; "
        f"findings={sum(state.batch_findings.values())} ({top_counts(state.batch_findings)}); "
        f"fetch-errors={state.batch_fetch_errors}",
        flush=True,
    )


def summary_document(state: AuditState, status: str, server: str, types: list[str],
                     findings_path: str) -> dict[str, Any]:
    return {
        "status": status,
        "startedAt": state.started_at,
        "updatedAt": utc_now(),
        "server": server,
        "scope": {
            "artifactTypes": types,
            "permissionScoped": True,
            "statement": "Complete means all artifacts enumerated and readable by this API key, not store-wide completeness.",
            "httpMethods": ["GET"],
        },
        "artifactsProcessed": state.processed,
        "artifactsFetched": state.fetched,
        "processedByType": dict(state.processed_by_type),
        "fetchedByType": dict(state.fetched_by_type),
        "expectedByType": state.expected_by_type,
        "affectedArtifacts": len(state.affected_artifacts),
        "findings": sum(state.finding_counts.values()),
        "findingsByRule": dict(state.finding_counts),
        "findingsByRisk": dict(state.risk_counts),
        "fetchErrors": state.fetch_errors,
        "listingErrors": state.listing_errors,
        "unresolvedTemplates": state.unresolved_templates,
        "duplicateSearchRowsSkipped": state.duplicates,
        "searchTotalCountChanges": state.total_count_changes,
        "findingsFile": findings_path,
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


def open_private_text_file(path: Path):
    """Open a streamed report as owner-only and refuse a symlink where the platform supports it."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    return os.fdopen(descriptor, "w", encoding="utf-8")


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
    unknown = set(types) - set(ARTIFACT_PATHS)
    if unknown:
        parser.error(f"unknown artifact types {sorted(unknown)}; choose from {list(TYPE_ORDER)}")
    return [kind for kind in TYPE_ORDER if kind in types]


def run_audit(arguments: argparse.Namespace, client: GetOnlyClient,
              findings_stream, summary_path: Path) -> tuple[AuditState, str]:
    state = AuditState()
    template_shapes: dict[str, SchemaShape] = {}
    status = "RUNNING"

    def checkpoint() -> None:
        print_progress(state)
        atomic_write_json(
            summary_path,
            summary_document(state, "RUNNING", arguments.server, arguments.selected_types,
                             str(arguments.out)),
        )
        state.reset_batch()

    try:
        for artifact_type in arguments.selected_types:
            remaining = None if arguments.limit is None else max(0, arguments.limit - state.processed)
            if remaining == 0:
                break
            for ref in iter_artifact_refs(client, artifact_type, arguments.page_size, state, remaining):
                try:
                    artifact = client.get_json(typed_artifact_path(ref))
                except AuthenticationError:
                    raise
                except Exception as error:
                    state.fetch_errors += 1
                    state.batch_fetch_errors += 1
                    print(f"! could not fetch {ref.artifact_type} {ref.artifact_id}: {error}", file=sys.stderr)
                    state.artifact_processed(artifact_type, fetched=False)
                    if state.processed % arguments.progress_every == 0:
                        checkpoint()
                    continue

                findings = list(audit_common(ref, artifact))
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
                            print(f"! could not resolve template {based_on} for {ref.artifact_id}: {error}",
                                  file=sys.stderr)
                    findings.extend(audit_instance(ref, artifact, shape))

                for item in state.add_findings(ref, findings):
                    findings_stream.write(json.dumps(item.json_record(), ensure_ascii=False) + "\n")
                findings_stream.flush()
                state.artifact_processed(artifact_type, fetched=True)
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
                             str(arguments.out)),
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
    parser.add_argument("--types", default=",".join(TYPE_ORDER),
                        help="comma-separated artifact types (default: template,element,field,instance)")
    parser.add_argument("--page-size", type=int, default=100,
                        help="search-deep page size (default: 100)")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help="print and checkpoint a brief summary every N processed artifacts (default: 300)")
    parser.add_argument("--limit", type=int, help="quick sample: stop after this many artifacts total")
    parser.add_argument("--out", default="cedar-artifact-audit-findings.jsonl",
                        help="stream findings as JSONL (default: cedar-artifact-audit-findings.jsonl)")
    parser.add_argument("--summary",
                        help="summary JSON path (default: <out without suffix>-summary.json)")
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
    if findings_path.resolve() == summary_path.resolve():
        parser.error("--out and --summary must name different files")
    arguments.out = str(findings_path)
    arguments.server = arguments.server.rstrip("/")
    findings_path.parent.mkdir(parents=True, exist_ok=True)

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
    print(f"Scope: {', '.join(arguments.selected_types)}; permission-scoped to this key")
    print(f"Findings: {findings_path}; summary: {summary_path}")
    print(f"Progress checkpoint: every {arguments.progress_every} artifacts")

    try:
        with open_private_text_file(findings_path) as findings_stream:
            state, status = run_audit(arguments, client, findings_stream, summary_path)
    except OSError as error:
        parser.error(f"cannot open findings file securely: {error}")

    print("\n=== Final summary ===")
    print(f"status: {status}")
    print(f"artifacts: processed={state.processed}, fetched={state.fetched} "
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
