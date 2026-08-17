#!/usr/bin/env python3
"""Find and repair the defects that live in stored CEDAR artifacts rather than in code.

Seven defects are tracked on BACKEND-ROADMAP.md under "Production Artifact Patch", and each one
begins the same way: a query over stored artifacts that says how far the shared corpus generalizes.
This is that query, and for the defects whose correction is settled it is also the rewrite.

Two sources are supported. A tree of artifact files is the corpus, and a Mongo artifact store is
what a deployment holds. Reporting is the default and mutates nothing; `--apply` writes.

The corpus keeps preprod captures beside their corrected copies, named `*-original.json`, so a
defect stays legible after it has been fixed everywhere it mattered. Those captures are evidence
and are skipped unless `--include-originals` asks for them.

Usage:

    cedar_artifact_patch.py --tree ../../cedar-test-artifacts/artifacts
    cedar_artifact_patch.py --mongo mongodb://localhost:27017 --db cedar
    cedar_artifact_patch.py --mongo mongodb://localhost:27017 --db cedar --items 26,27,28 --apply
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

JsonNode = Any

# The collections a CEDAR artifact store keeps, and the resource each holds.
COLLECTIONS = {
    "templates": "template",
    "template-elements": "element",
    "template-fields": "field",
    "template-instances": "instance",
}

CATALOG = "/Users/martin/CEDAR/cedar-term/catalog.sqlite"

# Prefixes and system keys an instance's `@context` always carries. Anything else naming a string
# is a term for a child or an attribute, which is what item 30 is about.
CONTEXT_PREFIXES = {
    "schema", "pav", "oslc", "rdfs", "xsd", "skos", "bibo", "dc", "dcterms", "prov", "rdf", "owl",
}
SYSTEM_CONTEXT_KEYS = {
    "schema:isBasedOn", "schema:name", "schema:description", "pav:derivedFrom", "pav:createdOn",
    "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy", "skos:notation", "rdfs:label",
    "schema:identifier",
}

# A granularity of a day or coarser can only be a date; below that a field may be a time of day or a
# full timestamp, and the granularity does not say which. Measured over the shared corpus, where 64
# of 64 date granularities agree and both sub-day granularities appear against two temporal types.
GRANULARITY_TO_TEMPORAL_TYPE = {
    "year": "xsd:date",
    "month": "xsd:date",
    "day": "xsd:date",
}
SUB_DAY_GRANULARITIES = {"hour", "minute", "second", "decimalSecond"}

DATE_TIME_VALUE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]")
TIME_ONLY_VALUE = re.compile(r"^\d{2}:\d{2}")

# What a constraint entry constrains, for a message that reads. A `classes` entry carries no acronym
# of its own, which is why the distinction is worth naming when one cannot be resolved.
CONSTRAINT_KINDS = {
    "ontologies": "this ontology constraint",
    "valueSets": "this value set",
    "classes": "this class",
    "branches": "this branch",
}

# `source` is the legacy free-text display string, so it holds either an acronym on its own or a name
# with the acronym in parentheses, as in "Human Disease Ontology (DOID)".
PARENTHESIZED_ACRONYM = re.compile(r"\(([A-Z][A-Z0-9_-]{1,20})\)\s*$")
BARE_ACRONYM = re.compile(r"^[A-Z][A-Z0-9_-]{1,20}$")


def acronym_from_source(source: Optional[str]) -> Optional[str]:
    """The acronym a legacy `source` string names, when it names one at all."""
    if not isinstance(source, str):
        return None
    parenthesized = PARENTHESIZED_ACRONYM.search(source)
    if parenthesized:
        return parenthesized.group(1)
    return source if BARE_ACRONYM.match(source.strip()) else None

ITEMS = {
    25: "temporal-type",
    26: "derived-from",
    27: "empty-id",
    28: "ui-pages",
    29: "empty-attribute-name",
    30: "orphan-context-term",
    31: "constraint-iri",
}


@dataclass
class Finding:
    """One defect in one artifact, and the repair for it when the correction is settled."""

    item: int
    source: str
    path: str
    note: str
    repair: Optional[Callable[[], None]] = None

    @property
    def slug(self) -> str:
        return ITEMS[self.item]

    @property
    def fixable(self) -> bool:
        return self.repair is not None


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    documents: int = 0
    unreadable: list[str] = field(default_factory=list)

    def add(self, finding: Finding) -> None:
        self.findings.append(finding)

    def by_item(self) -> dict[int, list[Finding]]:
        grouped: dict[int, list[Finding]] = collections.defaultdict(list)
        for f in self.findings:
            grouped[f.item].append(f)
        return grouped


# --------------------------------------------------------------------------------------------------
# The detectors. Each takes one node of a document and yields what is wrong with that node alone.
# --------------------------------------------------------------------------------------------------


def detect_derived_from(node: dict, source: str, path: str) -> Iterator[Finding]:
    """26. `pav:derivedFrom` names the artifact a copy was made from, and is optional: an artifact
    derived from nothing leaves it out. An empty string claims a derivation from an artifact whose
    identifier is empty, which is no artifact. Both model libraries now refuse it on read."""
    if node.get("pav:derivedFrom") == "":
        yield Finding(26, source, path, "empty pav:derivedFrom, dropping the key",
                      lambda: node.pop("pav:derivedFrom", None))


def detect_empty_id(node: dict, source: str, path: str, is_root: bool) -> Iterator[Finding]:
    """27. An identifier is the repository's to assign, and `null` is how a document says none has
    been assigned. An empty string says one was, and that it is empty. A stored artifact's own `@id`
    being empty is a louder problem than an occurrence's and is reported without a repair."""
    if node.get("@id") != "":
        return
    if is_root:
        yield Finding(27, source, path, "the artifact's own @id is empty, which no rewrite can settle")
    else:
        yield Finding(27, source, path, "empty @id below the artifact root, rewriting to null",
                      lambda: node.__setitem__("@id", None))


def detect_ui_pages(node: dict, source: str, path: str) -> Iterator[Finding]:
    """28. A template's `_ui` may carry `order`, `propertyLabels`, `propertyDescriptions`, `header`
    and `footer`, and the meta-schema pins `additionalProperties` to false, so `CedarValidator`
    rejects a template carrying `pages`. Every occurrence in the shared corpus is the empty array,
    so the key records nothing and dropping it loses nothing. A populated one would be a different
    finding, and is reported without a repair so it cannot be dropped silently."""
    ui = node.get("_ui")
    if not isinstance(ui, dict) or "pages" not in ui:
        return
    pages = ui["pages"]
    if pages:
        yield Finding(28, source, f"{path}/_ui/pages",
                      f"_ui.pages is populated ({json.dumps(pages)[:60]}), so it is not empty residue")
    else:
        yield Finding(28, source, f"{path}/_ui/pages", "empty _ui.pages, a key the meta-schema forbids",
                      lambda: ui.pop("pages", None))


def detect_empty_attribute_name(node: dict, source: str, path: str) -> Iterator[Finding]:
    """29. An attribute-value field's value is the list of attributes a user named, and each name is
    a sibling key holding that attribute's value. An empty name is an attribute nobody named: it has
    no sibling value and gets no `@context` term, because a property IRI for it would name a property
    nothing can be said about. A field naming no attributes is the empty list."""
    for key, value in list(node.items()):
        if not (isinstance(value, list) and value and all(isinstance(v, str) for v in value)):
            continue
        if "" not in value:
            continue
        context = node.get("@context")
        blocked = "" in node or (isinstance(context, dict) and "" in context)
        note = f"attribute-value field names {value.count('')} empty attribute(s)"
        if blocked:
            yield Finding(29, source, f"{path}/{key}",
                          f"{note}, and something is keyed by the empty name, so the value would be orphaned")
        else:
            yield Finding(29, source, f"{path}/{key}", f"{note}, dropping the empty name(s)",
                          lambda n=node, k=key: n.__setitem__(k, [v for v in n[k] if v != ""]))


def detect_temporal_type(node: dict, source: str, path: str,
                         values: Optional[list[str]] = None) -> Iterator[Finding]:
    """25. A temporal field states what kind of temporal value it holds in
    `_valueConstraints.temporalType`. A field declaring none cannot be filled in: it sits in the
    template as a slot nobody can complete, and no reader refuses it, so nothing surfaces the field
    until a user reaches it.

    `_ui.temporalGranularity` settles the type for a day or coarser. Below that a field may be a
    time of day or a full timestamp, so the values the field already holds decide, and where there
    are none the finding is reported without a repair."""
    ui = node.get("_ui")
    if not isinstance(ui, dict) or ui.get("inputType") != "temporal":
        return
    constraints = node.get("_valueConstraints")
    if isinstance(constraints, dict) and constraints.get("temporalType"):
        return

    granularity = ui.get("temporalGranularity")
    derived = GRANULARITY_TO_TEMPORAL_TYPE.get(granularity)
    if derived is None and granularity in SUB_DAY_GRANULARITIES:
        derived = temporal_type_from_values(values)
    if derived is None:
        yield Finding(25, source, path,
                      f"temporal field declares no temporalType and granularity {granularity!r} "
                      f"does not settle it; the values it holds have to")
        return

    def repair() -> None:
        target = node.setdefault("_valueConstraints", {})
        target["temporalType"] = derived

    yield Finding(25, source, path,
                  f"temporal field declares no temporalType, deriving {derived} from granularity "
                  f"{granularity!r}" if granularity in GRANULARITY_TO_TEMPORAL_TYPE else
                  f"temporal field declares no temporalType, deriving {derived} from the values it holds",
                  repair)


def temporal_type_from_values(values: Optional[list[str]]) -> Optional[str]:
    """The temporal type the given values agree on, or nothing when they disagree or there are none."""
    if not values:
        return None
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        if DATE_TIME_VALUE.match(value):
            seen.add("xsd:dateTime")
        elif TIME_ONLY_VALUE.match(value):
            seen.add("xsd:time")
    return seen.pop() if len(seen) == 1 else None


def detect_constraint_iri(node: dict, source: str, path: str,
                          catalog: "Catalog") -> Iterator[Finding]:
    """31. The versioned value-constraint shape names a source with `sourceSystem` and
    `sourceAcronym` and identifies it with a canonical `iri`; the older shape carried `sourceUri` and
    neither of the other two. Stored constraints are readable either way, because a tolerant reader
    defaults an absent `sourceSystem` to BioPortal and derives the IRI from the acronym, so this is
    self-description rather than a functional gap.

    The canonical IRI comes from the terminology catalog, the only place that mapping lives, and it is
    keyed by acronym. A `classes` entry has no acronym: it names its ontology only in `source`, the
    legacy free-text display string, so nothing can be looked up for it and the finding says so.

    A legacy constraint omitting all three additive fields is not broken, which is why nothing here
    is a functional gap. The count is coverage of the versioned shape, not a tally of breakage."""
    constraints = node.get("_valueConstraints")
    if not isinstance(constraints, dict):
        return
    for key in ("ontologies", "valueSets", "classes", "branches"):
        entries = constraints.get(key)
        if not isinstance(entries, list):
            continue
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            where = f"{path}/_valueConstraints/{key}[{index}]"
            if "sourceUri" in entry:
                yield Finding(31, source, where, "carries sourceUri, which is no longer authored")
            if entry.get("iri"):
                continue
            acronym = entry.get("acronym") or acronym_from_source(entry.get("source"))
            if not acronym:
                yield Finding(31, source, where,
                              f"no canonical iri, and {CONSTRAINT_KINDS[key]} names its ontology only "
                              f"as the free text {entry.get('source')!r}, which yields no acronym")
                continue
            canonical = catalog.iri_for(acronym)
            if canonical:
                yield Finding(31, source, where,
                              f"no canonical iri, writing {canonical} for {acronym}",
                              lambda e=entry, v=canonical: e.__setitem__("iri", v))
            else:
                yield Finding(31, source, where,
                              f"no canonical iri and the catalog cannot derive one for {acronym}")


def detect_orphan_context_terms(instance: dict, source: str, path: str,
                                declared: Optional[set[str]]) -> Iterator[Finding]:
    """30. The server assigns a property IRI to every attribute an instance names and leaves an
    assigned one alone, but nothing removed a term when the attribute it named was renamed or
    deleted, so a stored context accumulates one orphan per attribute a user changed their mind
    about.

    A term whose name is no key in the instance is not automatically an orphan: it may be a child the
    instance does not fill. Only the template says which, so without one the finding is reported and
    nothing is rewritten."""
    context = instance.get("@context")
    if not isinstance(context, dict):
        return
    for term, value in list(context.items()):
        if term.startswith("@") or term in CONTEXT_PREFIXES or term in SYSTEM_CONTEXT_KEYS:
            continue
        if not isinstance(value, str):
            continue
        if term in instance:
            continue
        if declared is None:
            yield Finding(30, source, f"{path}/@context/{term}",
                          "term names no key in the instance; without the template it cannot be told "
                          "from a child the instance does not fill")
        elif term not in declared:
            yield Finding(30, source, f"{path}/@context/{term}",
                          "term names neither a key in the instance nor a child the template declares",
                          lambda t=term: context.pop(t, None))


# --------------------------------------------------------------------------------------------------
# Walking a document. One pass, every detector, so a large store is read once.
# --------------------------------------------------------------------------------------------------


class Catalog:
    """The terminology catalog's acronym-to-canonical-IRI mapping, read-only and optional.

    Two schemas are in circulation: `ontology_source` in the current code and `ontology` in a store
    built before it. Neither is guaranteed to hold an IRI for a given acronym, and a store that is
    absent altogether answers nothing rather than failing."""

    def __init__(self, path: str = CATALOG):
        self.available = False
        self.unresolved: set[str] = set()
        self._iris: dict[str, str] = {}
        if not os.path.exists(path):
            return
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        except sqlite3.Error:
            return
        tables = {row[0] for row in
                  connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        query = None
        if "ontology_source" in tables:
            query = "SELECT acronym, iri FROM ontology_source WHERE iri IS NOT NULL"
        elif "ontology" in tables:
            query = "SELECT acronym, source_iri FROM ontology WHERE source_iri IS NOT NULL"
        if query:
            self._iris = {row[0]: row[1] for row in connection.execute(query)}
        self.available = True
        connection.close()

    def iri_for(self, acronym: str) -> Optional[str]:
        found = self._iris.get(acronym)
        if found is None:
            self.unresolved.add(acronym)
        return found

    def describe(self) -> str:
        if not self.available:
            return f"no terminology catalog at {CATALOG}, so no canonical IRI can be derived"
        return f"terminology catalog holds a canonical IRI for {len(self._iris)} acronyms"


def inspect_document(document: JsonNode, source: str, items: set[int], catalog: Catalog,
                     declared: Optional[set[str]] = None,
                     temporal_values: Optional[dict[str, list[str]]] = None) -> Iterator[Finding]:
    """Every finding in one artifact. `declared` is the set of child names its template declares, and
    `temporal_values` maps a field's name to the values instances hold for it; both are what the
    detectors that need more than the document itself get."""
    if 30 in items and isinstance(document, dict):
        yield from detect_orphan_context_terms(document, source, "", declared)

    def walk(node: JsonNode, path: str, is_root: bool) -> Iterator[Finding]:
        if isinstance(node, dict):
            if 26 in items:
                yield from detect_derived_from(node, source, path or "/")
            if 27 in items:
                yield from detect_empty_id(node, source, path or "/", is_root)
            if 28 in items:
                yield from detect_ui_pages(node, source, path)
            if 29 in items:
                yield from detect_empty_attribute_name(node, source, path)
            if 25 in items:
                name = path.rsplit("/", 1)[-1] if path else ""
                yield from detect_temporal_type(
                    node, source, path or "/", (temporal_values or {}).get(name))
            if 31 in items:
                yield from detect_constraint_iri(node, source, path or "/", catalog)
            for key, value in node.items():
                yield from walk(value, f"{path}/{key}", False)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                yield from walk(value, f"{path}[{index}]", False)

    yield from walk(document, "", True)


def declared_children(template: Optional[JsonNode]) -> Optional[set[str]]:
    """Every child name a template declares, at any depth. A term naming one of these is a child the
    instance does not fill rather than an orphan."""
    if not isinstance(template, dict):
        return None
    names: set[str] = set()

    def walk(node: JsonNode) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                for name, child in properties.items():
                    if not name.startswith("@") and name not in SYSTEM_CONTEXT_KEYS:
                        names.add(name)
                    walk(child)
            items = node.get("items")
            if isinstance(items, dict):
                walk(items)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(template)
    return names


# --------------------------------------------------------------------------------------------------
# Sources.
# --------------------------------------------------------------------------------------------------


def run_over_tree(root: str, items: set[int], catalog: Catalog, include_originals: bool,
                  apply_repairs: bool) -> Report:
    """Every JSON artifact under a directory. An instance's template is its sibling, which is how the
    corpus is laid out, so item 30 gets one where the layout supplies it."""
    report = Report()
    for directory, _, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith(".json"):
                continue
            if not include_originals and name.endswith("-original.json"):
                continue
            path = os.path.join(directory, name)
            source = os.path.relpath(path, root)
            try:
                with open(path) as handle:
                    document = json.load(handle)
            except (OSError, json.JSONDecodeError) as error:
                report.unreadable.append(f"{source}: {error}")
                continue
            report.documents += 1

            declared = None
            if 30 in items and name.startswith("instance-"):
                # The corpus names an instance's template for the directory holding both, and an
                # instance may be one of several renderings of the same document.
                sibling = os.path.join(directory, f"template-{os.path.basename(directory)}.json")
                if os.path.exists(sibling):
                    try:
                        with open(sibling) as handle:
                            declared = declared_children(json.load(handle))
                    except (OSError, json.JSONDecodeError):
                        declared = None

            found = list(inspect_document(document, source, items, catalog, declared))
            for finding in found:
                report.add(finding)
            if apply_repairs and any(f.fixable for f in found):
                for finding in found:
                    if finding.repair:
                        finding.repair()
                write_json(path, document)
    return report


def write_json(path: str, document: JsonNode) -> None:
    """Rewrite a corpus file in the two-space form the corpus is committed in, newline-terminated."""
    with open(path, "w") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def run_over_mongo(uri: str, database: str, items: set[int], catalog: Catalog,
                   apply_repairs: bool, limit: Optional[int]) -> Report:
    """Every artifact in a store. Templates are read first, so an instance's `schema:isBasedOn` can
    be resolved for item 30 and a template's temporal fields can be checked against the values its
    instances hold for item 25."""
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pymongo is not installed: pip3 install pymongo")

    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    store = client[database]
    report = Report()

    templates: dict[str, JsonNode] = {}
    if 30 in items:
        for document in store["templates"].find({}, {"_id": 0}):
            identifier = document.get("@id")
            if identifier:
                templates[identifier] = document

    for collection, kind in COLLECTIONS.items():
        cursor = store[collection].find({})
        if limit:
            cursor = cursor.limit(limit)
        for stored in cursor:
            mongo_id = stored.pop("_id", None)
            report.documents += 1
            source = f"{collection}/{stored.get('@id') or mongo_id}"

            declared = None
            if 30 in items and kind == "instance":
                based_on = stored.get("schema:isBasedOn")
                declared = declared_children(templates.get(based_on))

            found = list(inspect_document(stored, source, items, catalog, declared))
            for finding in found:
                report.add(finding)
            if apply_repairs and any(f.fixable for f in found):
                for finding in found:
                    if finding.repair:
                        finding.repair()
                store[collection].replace_one({"_id": mongo_id}, stored)
    client.close()
    return report


# --------------------------------------------------------------------------------------------------
# Reporting.
# --------------------------------------------------------------------------------------------------


def print_report(report: Report, catalog: Catalog, applied: bool, samples: int) -> None:
    print(f"{report.documents} artifacts read")
    if report.unreadable:
        print(f"{len(report.unreadable)} unreadable:")
        for entry in report.unreadable[:samples]:
            print(f"    {entry}")
    print(catalog.describe())
    print()

    grouped = report.by_item()
    if not grouped:
        print("no findings")
        return

    verb = "repaired" if applied else "repairable"
    print(f"{'item':>5}  {'defect':<22} {'found':>6} {verb:>11}  {'reported':>9}")
    for item in sorted(ITEMS):
        findings = grouped.get(item, [])
        if not findings:
            continue
        fixable = sum(1 for f in findings if f.fixable)
        print(f"{item:>5}  {ITEMS[item]:<22} {len(findings):>6} {fixable:>11}  "
              f"{len(findings) - fixable:>9}")
    print()

    for item in sorted(grouped):
        findings = grouped[item]
        print(f"--- {item}. {ITEMS[item]} ({len(findings)}) ---")
        per_source = collections.Counter(f.source for f in findings)
        for source, count in per_source.most_common(samples):
            print(f"    {count:>5}  {source}")
        if len(per_source) > samples:
            print(f"           … {len(per_source) - samples} more artifacts")
        for finding in findings[:2]:
            print(f"      e.g. {finding.path or '/'} — {finding.note}")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find and repair defects in stored CEDAR artifacts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Reporting is the default. Nothing is written without --apply.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--tree", help="directory of artifact files, such as the shared corpus")
    source.add_argument("--mongo", help="Mongo URI of an artifact store")
    parser.add_argument("--db", default="cedar", help="database name for --mongo (default: cedar)")
    parser.add_argument("--items", default=",".join(str(i) for i in sorted(ITEMS)),
                        help="which roadmap items to check, comma-separated (default: all)")
    parser.add_argument("--apply", action="store_true", help="write the repairs")
    parser.add_argument("--include-originals", action="store_true",
                        help="also read *-original.json, the preprod captures a tree keeps as evidence")
    parser.add_argument("--limit", type=int, help="read at most this many artifacts per collection")
    parser.add_argument("--samples", type=int, default=10, help="artifacts to name per item")
    parser.add_argument("--catalog", default=CATALOG, help="terminology catalog for canonical IRIs")
    parser.add_argument("--json", help="write the findings to this file as JSON")
    arguments = parser.parse_args()

    try:
        items = {int(value) for value in arguments.items.split(",") if value.strip()}
    except ValueError:
        parser.error(f"--items takes numbers from {sorted(ITEMS)}")
    unknown = items - set(ITEMS)
    if unknown:
        parser.error(f"unknown items {sorted(unknown)}; known items are {sorted(ITEMS)}")

    catalog = Catalog(arguments.catalog)

    if arguments.tree:
        if arguments.apply and arguments.include_originals:
            parser.error("--apply with --include-originals would rewrite the captures kept as evidence")
        report = run_over_tree(arguments.tree, items, catalog, arguments.include_originals,
                               arguments.apply)
    else:
        report = run_over_mongo(arguments.mongo, arguments.db, items, catalog, arguments.apply,
                                arguments.limit)

    print_report(report, catalog, arguments.apply, arguments.samples)

    if arguments.json:
        with open(arguments.json, "w") as handle:
            json.dump([{"item": f.item, "defect": f.slug, "artifact": f.source, "path": f.path,
                        "note": f.note, "repairable": f.fixable} for f in report.findings],
                      handle, indent=2)
        print(f"findings written to {arguments.json}")

    if catalog.unresolved:
        print(f"acronyms the catalog cannot derive an IRI for: "
              f"{', '.join(sorted(catalog.unresolved))}")


if __name__ == "__main__":
    main()
