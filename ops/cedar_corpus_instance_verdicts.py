#!/usr/bin/env python3
"""Record the Java validator's verdict on every instance in the shared corpus, for the TypeScript gate.

The TypeScript library must reach the same verdict as ``cedar-model-validation-library`` on every
instance: the Java verdict is what the server applies to a write, and the TypeScript one is what the
embeddable editor's Save follows. This script asks the Java validator to judge each corpus instance
against the corpus template it names, and writes the answers as a fixture the TypeScript library's
``InstanceVerdictConcordance`` spec reads, with a lock naming the validator commit and the corpus
commit they came from and the fixture's digest.

    python3 ops/cedar_corpus_instance_verdicts.py \\
      --corpus "$CEDAR_HOME/cedar-test-artifacts/artifacts" \\
      --out "$CEDAR_HOME/cedar-model-typescript-library/itest/resources/concordance"

Every instance whose template the corpus holds is a case. So is each probe: a corpus case changed by
JSON Patch operations on its instance and its template into a shape the corpus holds no example of,
which the spec applies the same way before reading either document. Java judges each instance as the
server would store it from an editor's save, and each case records the operations that completion
added, so the spec can judge that same document verbatim as well as the instance as the editor holds
it. A stored probe changes the completed document, the shape a verbatim write stores, and is judged
only verbatim. The verdict comes from the validation library
``ops/cedar_validate.sh`` builds from its sibling checkout, which must be committed unless
``--working-tree`` records that it is not.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

OPS = Path(__file__).resolve().parent
sys.path.insert(0, str(OPS))
import cedar_artifact_validation_audit as audit  # noqa: E402

FIXTURE = "instance-verdicts.json"
LOCK = "instance-verdicts-lock.json"


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()


def document(path: Path) -> Any:
    """A corpus file's JSON, or None for one that is deliberately not a JSON document."""
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


SERVER_STAMPS = {"pav:createdOn": "2026-01-01T00:00:00-08:00", "pav:lastUpdatedOn": "2026-01-01T00:00:00-08:00",
                 "pav:createdBy": "https://metadatacenter.org/users/00000000-0000-4000-8000-000000000000",
                 "oslc:modifiedBy": "https://metadatacenter.org/users/00000000-0000-4000-8000-000000000000"}
MINTED_INSTANCE = "https://repo.metadatacenter.org/template-instances/00000000-0000-4000-8000-000000000001"
MINTED_ELEMENT = "https://repo.metadatacenter.org/template-element-instances/00000000-0000-4000-8000-{:012d}"


def as_the_server_stores(instance: dict, template: dict) -> dict:
    """The instance as the server would store it from an editor's save, which is what it validates.

    An editor sends an instance without the provenance, the identity or the element-occurrence
    identifiers the server writes, and without the name and template its host supplies, so a corpus
    instance made by the editor lacks them. The host names the template and the instance; the server
    stamps the four provenance properties and mints the missing identifiers before validating. This
    does all of that, with fixed values.
    """
    stored = json.loads(json.dumps(instance))
    if not stored.get("schema:isBasedOn"):
        stored["schema:isBasedOn"] = template["@id"]
    if "schema:name" not in stored:
        stored["schema:name"] = "Corpus instance"
    if "schema:description" not in stored:
        stored["schema:description"] = ""
    for key, value in SERVER_STAMPS.items():
        if not stored.get(key):
            stored[key] = value
    if not stored.get("@id"):
        stored["@id"] = MINTED_INSTANCE
    minted = iter(range(1, 10 ** 6))

    def mint(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                mint(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key == "@context" or not isinstance(value, (dict, list)):
                    continue
                for occurrence in value if isinstance(value, list) else [value]:
                    if isinstance(occurrence, dict) and "@context" in occurrence and not occurrence.get("@id"):
                        occurrence["@id"] = MINTED_ELEMENT.format(next(minted))
                mint(value)

    mint(stored)
    return stored


def completion(before: Any, after: Any, path: str = "") -> list[dict[str, Any]]:
    """The JSON Patch operations that turn an instance into its completed form: the keys completion set."""
    operations: list[dict[str, Any]] = []
    if isinstance(before, dict) and isinstance(after, dict):
        for name, value in after.items():
            here = path + key(name)
            if name not in before or (not isinstance(value, (dict, list)) and before[name] != value):
                operations.append(put(here, value))
            else:
                operations += completion(before[name], value, here)
    elif isinstance(before, list) and isinstance(after, list):
        for index, (old, new) in enumerate(zip(before, after)):
            operations += completion(old, new, f"{path}/{index}")
    return operations


def pairs(corpus: Path) -> list[tuple[str, Path, Path]]:
    """Every corpus instance with its template, keyed by its case directory.

    Only an instance with a template in its own case directory is a case, which the CEE suite's are:
    its instances name no template, since the host supplies it. An instance elsewhere names a template
    by identity, but several cases copy a template under one identity, and an instance can hold
    fields its named template's copy lacks, so a pairing by identity says nothing reliable.
    """
    beside: dict[Path, Path] = {}
    for path in sorted(corpus.glob("*/*/template-*.json")):
        if "generated" not in path.name and isinstance(document(path), dict):
            beside.setdefault(path.parent, path)
    found = []
    for path in sorted(corpus.glob("*/*/instance-*.json")):
        instance = document(path) if "generated" not in path.name else None
        template = beside.get(path.parent)
        if isinstance(instance, dict) and template is not None:
            found.append((f"{path.parent.parent.name}/{path.parent.name}", path, template))
    return found


# A probe is a corpus case the validator accepts, changed by a few JSON Patch operations on its instance
# and on its template into a shape the corpus holds no example of. Production holds thousands of such
# shapes, and the two libraries had disagreed about them without any case showing it: unfilled or
# half-filled controlled terms, a template that requires fewer children than either model writes, a
# date that requires only @value, a static field holding `{}`, a container admitting further literals.
PROBE_CLASS = "https://example.org/classes/Probe"
IRI_VALUES: dict[str, dict[str, Any]] = {
    "empty": {},
    "label-null": {"rdfs:label": None},
    "label-empty": {"rdfs:label": ""},
    "label-text": {"rdfs:label": "Probe"},
    "class-only": {"@type": PROBE_CLASS},
    "class-and-label-null": {"@type": PROBE_CLASS, "rdfs:label": None},
    "class-and-label-text": {"@type": PROBE_CLASS, "rdfs:label": "Probe"},
    "value-null": {"@value": None},
    "id-empty": {"@id": ""},
    "undeclared-key": {"rdfs:label": None, "probe": "Probe"},
}
# The schema a template gives `_annotations`, as the libraries write it and production templates hold it.
ANNOTATIONS_SCHEMA = {
    "type": "object",
    "patternProperties": {"^.+$": {"oneOf": [
        {"type": "object", "properties": {"@id": {"type": "string", "format": "uri"}}, "additionalProperties": False},
        {"type": "object", "properties": {"@value": {"type": ["string", "number", "boolean", "null"]}},
         "additionalProperties": False}]}},
    "additionalProperties": False}
PROBE_PROPERTY = "https://example.org/properties/Probe"
ANNOTATIONS: dict[str, Any] = {
    "annotation-iri": {PROBE_PROPERTY: {"@id": PROBE_CLASS}},
    "annotation-literal": {PROBE_PROPERTY: {"@value": "Probe"}},
    "annotation-number": {PROBE_PROPERTY: {"@value": 5}},
    "annotation-boolean": {PROBE_PROPERTY: {"@value": True}},
    "annotation-null-value": {PROBE_PROPERTY: {"@value": None}},
    "annotation-null-iri": {PROBE_PROPERTY: {"@id": None}},
    "annotation-empty": {PROBE_PROPERTY: {}},
    "annotation-iri-and-value": {PROBE_PROPERTY: {"@id": PROBE_CLASS, "@value": "Probe"}},
    "annotation-extra-key": {PROBE_PROPERTY: {"@id": PROBE_CLASS, "rdfs:label": "Probe"}},
    "annotation-relative-iri": {PROBE_PROPERTY: {"@id": "Probe"}},
    "annotation-blank-key": {"": {"@value": "Probe"}},
    "annotation-not-object": {PROBE_PROPERTY: "Probe"},
    "annotations-empty": {},
    "annotations-list": [],
}
ROOT_TYPES: dict[str, Any] = {
    "type-iri": PROBE_CLASS,
    "type-list": [PROBE_CLASS],
    "type-empty-list": [],
    "type-repeated": [PROBE_CLASS, PROBE_CLASS],
    "type-relative": "Probe",
    "type-number": 5,
    "type-null": None,
}

# The schema older templates give `additionalProperties` to admit further literal values.
OPEN_LITERALS = {"type": "object",
                 "properties": {"@value": {"type": ["string", "null"]}, "@type": {"type": "string", "format": "uri"}},
                 "required": ["@value"], "additionalProperties": False}


def put(path: str, value: Any) -> dict[str, Any]:
    return {"op": "add", "path": path, "value": value}


def drop(path: str) -> dict[str, Any]:
    return {"op": "remove", "path": path}


def key(name: str) -> str:
    """A JSON Pointer to one member of an object."""
    return "/" + name.replace("~", "~0").replace("/", "~1")


def probes(case: str, template: dict) -> list[tuple[str, list[dict[str, Any]], list[dict[str, Any]]]]:
    """A corpus case's probes: each one's name and the operations it applies to the instance and the template."""
    if case in ("cee-suite/021", "cee-suite/027"):
        field = "Untitled" if case == "cee-suite/021" else "Link here"
        found = [(name, [put(key(field), value)], []) for name, value in IRI_VALUES.items()]
        if case == "cee-suite/021":
            unrequired = [name for name in template["required"] if name != field]
            found += [
                ("absent", [drop(key(field))], []),
                ("absent-unrequired", [drop(key(field))], [put("/required", unrequired)]),
                ("extra-literal", [put(key("Probe"), {"@value": "Probe"})], []),
                ("extra-literal-admitted", [put(key("Probe"), {"@value": "Probe"})],
                 [put("/additionalProperties", OPEN_LITERALS)]),
                ("extra-iri-admitted", [put(key("Probe"), {"@id": PROBE_CLASS})],
                 [put("/additionalProperties", OPEN_LITERALS)]),
                ("context-property-mismatch", [put("/@context" + key(field), "https://example.org/properties/Probe")], []),
                ("context-term-undeclared", [put("/@context" + key("Probe"), "https://example.org/properties/Probe")], []),
                ("context-term-missing", [drop("/@context" + key(field))], []),
                ("context-prefix-missing", [drop("/@context/xsd")], []),
            ]
        return found
    if case == "cee-suite/015":
        field = key("Rich Text Standalone")
        return [("static-empty", [put(field, {})], []), ("static-value-null", [put(field, {"@value": None})], [])]
    if case == "cee-suite/017":
        field = key("Datetime Field 1 (month/year)")
        date = {"@value": "2023-08-31", "@type": "xsd:date"}
        label_required = [put("/properties" + field + "/required", ["@value", "rdfs:label"])]
        return [("date-unfilled-untyped", [put(field, {"@value": None})], []),
                ("date-filled-untyped", [put(field, {"@value": "2023-08-31"})], []),
                ("label-null-required", [put(field, {**date, "rdfs:label": None})], label_required),
                ("label-absent-required", [put(field, date)], label_required)]
    if case == "cee-suite/032":
        return [("number-unfilled-untyped", [put(key("Numeric"), {"@value": None})], [])]
    if case == "cee-suite/008":
        # An instance's annotations and its root @type are its own, not the server's, so every save
        # writes them as the instance holds them. Production templates declare `_annotations`; this
        # case's template does not, so each annotation probe declares it and one leaves it undeclared.
        declared = [put("/properties/_annotations", ANNOTATIONS_SCHEMA)]
        return ([(name, [put("/_annotations", value)], declared) for name, value in ANNOTATIONS.items()]
                + [("annotation-undeclared", [put("/_annotations", ANNOTATIONS["annotation-iri"])], [])]
                + [(name, [put("/@type", value)], []) for name, value in ROOT_TYPES.items()]
                + [("derived-from-relative", [put("/pav:derivedFrom", "Probe")], []),
                   ("derived-from-absolute", [put("/pav:derivedFrom", PROBE_CLASS)], [])])
    return []


def first_occurrence(node: Any, path: str = "") -> str | None:
    """The pointer to the first element occurrence below the root, in document order."""
    if isinstance(node, list):
        for index, item in enumerate(node):
            found = first_occurrence(item, f"{path}/{index}")
            if found is not None:
                return found
    elif isinstance(node, dict):
        if path and "@context" in node:
            return path
        for name, value in node.items():
            if name != "@context" and isinstance(value, (dict, list)):
                found = first_occurrence(value, path + key(name))
                if found is not None:
                    return found
    return None


def stored_probes(case: str, completed: dict) -> list[tuple[str, list[dict[str, Any]]]]:
    """A case's stored probes: its completed document with one of its own keys missing or malformed.

    The server writes these keys on an editor's save, so only a verbatim write can store a document
    without them, and only a judgement of the document as it stands can say whether it may.
    """
    if case != "cee-suite/008":
        return []
    occurrence = first_occurrence(completed)
    return [("stored-element-id-absent", [drop(occurrence + "/@id")]),
            ("stored-element-id-null", [put(occurrence + "/@id", None)]),
            ("stored-element-id-blank", [put(occurrence + "/@id", "")]),
            ("stored-element-id-relative", [put(occurrence + "/@id", "Probe")]),
            ("stored-root-id-relative", [put("/@id", "Probe")]),
            ("stored-based-on-relative", [put("/schema:isBasedOn", "Probe")]),
            ("stored-root-id-absent", [drop("/@id")]),
            ("stored-root-id-null", [put("/@id", None)]),
            ("stored-based-on-absent", [drop("/schema:isBasedOn")]),
            ("stored-name-absent", [drop("/schema:name")]),
            ("stored-name-empty", [put("/schema:name", "")]),
            ("stored-created-on-absent", [drop("/pav:createdOn")]),
            ("stored-created-on-null", [put("/pav:createdOn", None)]),
            # The format admits a timestamp leniently and the model reads one strictly, each in its own
            # ways, and a stored timestamp must satisfy both: one probe for each combination.
            ("stored-created-on-colonless-offset", [put("/pav:createdOn", "2026-01-15T12:34:56-0800")]),
            ("stored-created-on-day-past-month", [put("/pav:createdOn", "2026-02-30T00:00:00-08:00")]),
            ("stored-created-on-end-of-day", [put("/pav:createdOn", "2026-01-15T24:00:00Z")]),
            ("stored-created-on-lowercase-t", [put("/pav:createdOn", "2026-01-15t12:34:56Z")]),
            ("stored-created-on-no-seconds", [put("/pav:createdOn", "2026-01-15T12:34-08:00")]),
            ("stored-created-on-hour-offset", [put("/pav:createdOn", "2026-01-15T12:34:56-08")]),
            ("stored-created-on-date-only", [put("/pav:createdOn", "2026-01-01")]),
            ("stored-created-on-offset-too-far", [put("/pav:createdOn", "2026-01-15T12:34:56+18:01")]),
            ("stored-created-on-leap-second", [put("/pav:createdOn", "2016-12-31T23:59:60Z")]),
            ("stored-derived-from-malformed", [put("/pav:derivedFrom", "not an IRI")])]


def patched(document: dict, operations: list[dict[str, Any]]) -> dict:
    """The document with JSON Patch `add` and `remove` operations applied, as the spec applies them."""
    copy = json.loads(json.dumps(document))
    for operation in operations:
        keys = [part.replace("~1", "/").replace("~0", "~") for part in operation["path"].split("/")[1:]]
        parent = copy
        for part in keys[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        if operation["op"] == "remove":
            del parent[keys[-1]]
        else:
            parent[keys[-1]] = operation["value"]
    return copy


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus", required=True, help="the shared corpus's artifacts directory")
    parser.add_argument("--out", required=True, help="the directory receiving the fixture and its lock")
    parser.add_argument("--validation-library", default=str(OPS.parent.parent / "cedar-model-validation-library"),
                        help="the cedar-model-validation-library checkout the verdicts come from")
    parser.add_argument("--working-tree", action="store_true", help="allow uncommitted validator sources")
    arguments = parser.parse_args(argv)

    corpus, out, library = Path(arguments.corpus), Path(arguments.out), Path(arguments.validation_library)
    dirty = git(library, "status", "--porcelain", "--", "src/main")
    if dirty and not arguments.working_tree:
        parser.error(f"{library} has uncommitted sources; commit them or pass --working-tree")
    classpath = audit.run_validate_sh("classpath", 900)
    bridge = audit.ValidationBridge("java", classpath, OPS / "cedar_validation_bridge.java", 16, "2g",
                                    out / "instance-verdicts-bridge.log", 120)
    hello = bridge.start()
    print(f"Validator: {hello.get('validator')} on Java {hello.get('java')}")
    cases: list[dict[str, Any]] = []

    def judge(case: str, instance: dict, template: dict, entry: dict[str, Any],
              stored: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        bridge.cache_template(template["@id"], template)
        completed = as_the_server_stores(instance, template)
        answer = bridge.validate("instance", patched(completed, stored or []), template["@id"])
        if answer.get("status") not in ("valid", "invalid"):
            raise RuntimeError(f"{case}: the validator gave no verdict: {answer}")
        added = completion(instance, completed)
        return {"id": case, **entry, **({"completion": added} if added else {}),
                "javaValid": answer["status"] == "valid",
                "javaErrors": [error.get("message", "") for error in (answer.get("errors") or [])[:3]]}

    try:
        for case, instance_path, template_path in pairs(corpus):
            template = json.loads(template_path.read_text())
            instance = json.loads(instance_path.read_text())
            entry = {"instance": instance_path.relative_to(corpus).as_posix(),
                     "template": template_path.relative_to(corpus).as_posix()}
            cases.append(judge(case, instance, template, entry))
            accepted = cases[-1]["javaValid"]
            found = probes(case, template)
            if case == "cee-suite/008":
                # An element occurrence's own classes, which every save writes as the instance holds them.
                occurrence = first_occurrence(instance)
                found += [("element-type", [put(occurrence + "/@type", PROBE_CLASS)], []),
                          ("element-type-list", [put(occurrence + "/@type", [PROBE_CLASS, PROBE_PROPERTY])], []),
                          ("element-type-relative", [put(occurrence + "/@type", "Probe")], [])]
            if found and not accepted:
                raise RuntimeError(f"{case}: only a case the validator accepts can be probed")
            for probe, on_instance, on_template in found:
                patch = {name: operations for name, operations in (("instance", on_instance), ("template", on_template))
                         if operations}
                cases.append(judge(f"{case}#{probe}", patched(instance, on_instance), patched(template, on_template),
                                   {**entry, "patch": patch}))
            stored_found = stored_probes(case, as_the_server_stores(instance, template))
            if stored_found and not accepted:
                raise RuntimeError(f"{case}: only a case the validator accepts can be probed")
            for probe, on_stored in stored_found:
                cases.append(judge(f"{case}#{probe}", instance, template, {**entry, "patch": {"stored": on_stored}},
                                   on_stored))
    finally:
        bridge.close()
    (out / "instance-verdicts-bridge.log").unlink(missing_ok=True)
    fixture = json.dumps({"cases": cases}, indent=1, ensure_ascii=False) + "\n"
    (out / FIXTURE).write_text(fixture)
    lock = {"javaCommit": git(library, "rev-parse", "HEAD"),
            "corpusCommit": git(corpus, "rev-parse", "HEAD"),
            "sha256": hashlib.sha256(fixture.encode()).hexdigest(),
            "caseCount": len(cases)}
    if dirty:
        lock["javaWorkingTree"] = True
    (out / LOCK).write_text(json.dumps(lock, indent=2) + "\n")
    print(f"{len(cases)} cases, {sum(c['javaValid'] for c in cases)} valid, written to {out / FIXTURE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
