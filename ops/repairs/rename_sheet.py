#!/usr/bin/env python3
"""Draft the rename mapping a template's instances imply, for an owner to confirm."""
import json, os, pathlib, urllib.request, urllib.parse, sys, importlib.util, collections, random, re, difflib
import concurrent.futures as cf

OPS = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path(os.environ.get("CEDAR_HOME", pathlib.Path.home() / "CEDAR"))
spec = importlib.util.spec_from_file_location("cedar_artifact_rest_audit",
                                              OPS / "cedar_artifact_rest_audit.py")
rest = importlib.util.module_from_spec(spec); sys.modules[spec.name] = rest; spec.loader.exec_module(rest)
spec = importlib.util.spec_from_file_location("cedar_artifact_repair",
                                              pathlib.Path(__file__).resolve().parent
                                              / "cedar_artifact_repair.py")
repair = importlib.util.module_from_spec(spec); sys.modules[spec.name] = repair
spec.loader.exec_module(repair)
KEY = pathlib.Path.home().joinpath('.cedar-admin-key').read_text().strip()
RESERVED = {'@context','@id','@type','schema:isBasedOn','schema:name','schema:description','pav:createdOn',
            'pav:createdBy','pav:lastUpdatedOn','oslc:modifiedBy','pav:derivedFrom','_annotations'}
SAMPLE = 40
VALUES = 10


def get(artifact_id, segment):
    url = f"https://resource.metadatacenter.org/{segment}/{urllib.parse.quote(artifact_id, safe='')}"
    request = urllib.request.Request(url, headers={'Authorization': f'apiKey {KEY}', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=90) as answer:
            return json.load(answer)
    except Exception:
        return None


def render(value, depth=0):
    """A field value as a reader would recognise it, or None where there is nothing to show."""
    if isinstance(value, list):
        shown = [render(v, depth) for v in value]
        shown = [s for s in shown if s]
        return "; ".join(shown[:3]) or None
    if not isinstance(value, dict):
        return str(value) if value not in (None, "") else None
    if "@value" in value:
        literal = value["@value"]
        return None if literal in (None, "") else str(literal)
    # An element instance carries an @id of its own alongside its children; the children are what a
    # reader recognises, so they are read before the identifier is fallen back on.
    if depth < 2:
        inner = []
        for k, v in value.items():
            if k.startswith("@") or k == "rdfs:label":
                continue
            shown = render(v, depth + 1)
            if shown:
                inner.append(f"{k}={shown}")
        if inner:
            return ", ".join(inner[:3])
    if "@id" in value:
        label = value.get("rdfs:label") or value.get("skos:prefLabel")
        return str(label) if label else str(value["@id"]).rsplit("/", 1)[-1]
    return None


def answer_letters(options):
    """Lettered answers for one key: each candidate field, then delete, then keep."""
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXY"
    choices = list(options) + ["delete", "keep"]
    return list(zip(letters, choices))


def supersedes(found, stale, carried):
    """The declared name already holding this key's value, where one does in every instance.

    Nothing is renamed here and nothing is lost: the value is in the instance twice, once under a
    name the template declares and once under the name it dropped. The second copy is simply deleted.
    """
    seen = found["superseded"].get(stale) or collections.Counter()
    if not seen:
        return None
    name, count = seen.most_common(1)[0]
    return name if count == carried else None


def shared_values(found, stale, name):
    """Whether the two names hold values in common.

    Shared values may help rank a proposal but do not establish equivalent field meanings.
    """
    prefix = found["at"].get(stale, "")
    old = {v for v in (found["staleValues"].get(stale) or []) if len(v) > 2}
    new = {v for v in (found["declaredValues"].get(declared_path(prefix, name)) or []) if len(v) > 2}
    return old & new


def tidy(values):
    """Distinct values, longest-first trimmed, in the order the instances gave them."""
    seen, out = set(), []
    for v in values:
        v = " ".join(str(v).split())
        if len(v) > 58:
            v = v[:55] + "..."
        if v and v not in seen:
            seen.add(v); out.append(v)
        if len(out) >= VALUES:
            break
    return out



def distinct(values, limit=VALUES):
    """Values in the order the instances gave them, each whole, without repeats."""
    seen, out = set(), []
    for value in values:
        value = " ".join(str(value).split())
        if value and value not in seen:
            seen.add(value)
            out.append(value)
        if len(out) >= limit:
            break
    return out


def elide(text, budget):
    """Shorten a value while keeping both ends, since what distinguishes it may be at either.

    Truncating from the right hides the one part that tells two values apart when they share a long
    prefix, which is exactly the case for a path expression left unsubstituted by a translation.
    """
    text = " ".join(str(text).split())
    if len(text) <= budget:
        return text
    head = (budget - 1) // 2
    return text[:head] + "…" + text[-(budget - 1 - head):]


def normalise(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())


def tokens(name):
    return {t for t in re.split(r'[^a-z0-9]+', name.lower()) if t}


def token_weights(names):
    """How distinctive each word is among the candidates.

    A word shared with only one candidate identifies it; one shared with most of them says nothing.
    `Gene` picks out `Biomarker Gene Name` on its own, while `Name` picks out nothing.
    """
    seen = collections.Counter()
    for name in names:
        for token in tokens(name):
            seen[token] += 1
    return {token: 1.0 / count for token, count in seen.items()}


def score(stale, candidate, weights):
    """How strongly a stale key and a declared name look like the same field renamed."""
    shared = tokens(stale) & tokens(candidate)
    whole = tokens(stale) | tokens(candidate)
    weighted = sum(weights.get(t, 1.0) for t in shared) / max(
        1e-9, sum(weights.get(t, 1.0) for t in whole))
    spelling = difflib.SequenceMatcher(None, normalise(stale), normalise(candidate)).ratio()
    return max(weighted, spelling * 0.9), shared


def propose_all(stale_keys, candidates, prevalence=None):
    """Pair each stale key with at most one declared name, strongest pairing first.

    A rename is one-to-one, so a declared name claimed by one key is not offered to another. Which
    key claims a contested name is settled by how many instances carry it as well as by how alike the
    names are: a key in every instance records what the template used to call the field, while one in
    a single instance is far likelier to be a stray.
    """
    if not candidates:
        return {s: (None, "no candidate", 0.0) for s in stale_keys}
    prevalence = prevalence or {}
    most = max(prevalence.values()) if prevalence else 1
    weights = token_weights(candidates)
    by_norm = {normalise(c): c for c in candidates}
    taken_stale, taken_name, out = set(), set(), {}
    # A name that differs only in case or punctuation is the same name, whatever else wants it.
    for s in stale_keys:
        match = by_norm.get(normalise(s))
        if match and match not in taken_name:
            out[s] = (match, "spelling", 1.0)
            taken_stale.add(s); taken_name.add(match)
    pairs = []
    for s in stale_keys:
        if s in taken_stale:
            continue
        common = 0.6 + 0.4 * (prevalence.get(s, most) / max(1, most))
        for c in candidates:
            if c in taken_name:
                continue
            value, shared = score(s, c, weights)
            pairs.append((value * common, s, c,
                          "shared wording" if shared else "similar spelling"))
    pairs.sort(reverse=True, key=lambda p: (p[0], p[1], p[2]))
    for value, s, c, basis in pairs:
        if s in taken_stale or c in taken_name or value < 0.30:
            continue
        taken_stale.add(s); taken_name.add(c)
        out[s] = (c, basis, round(value, 2))
    for s in stale_keys:
        out.setdefault(s, (None, "no candidate", 0.0))
    return out


def settled_mapping():
    """Every rename the operator has already confirmed, loaded the way the repair loads it."""
    path = HOME / "mapping-all.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}


def element_children(definition):
    """Each child a container declares that is itself a container, with its declaration."""
    out = {}
    for name, child, _multiple, error in rest.direct_schema_children(definition):
        if not error and child is not None and repair.is_element(child):
            out[name] = child
    return out


def occurrences(value):
    """A child's value as the occurrences it holds, whether or not it is declared repeating."""
    return [v for v in (value if isinstance(value, list) else [value]) if isinstance(v, dict)]


def walk_container(node, definition, prefix, found):
    """Record what a container carries that its declaration does not name, at any depth.

    The walk descends only into a child the template declares as an element, so a path it reports
    names the route through the template: every segment but the last is a declared name. A key the
    template does not declare is recorded where it sits and not entered, because there is nothing to
    read it against until someone says where it belongs.
    """
    declared = [n for n, _c, _m, e in rest.direct_schema_children(definition) if not e]
    found["containers"].setdefault(prefix, {"definition": definition, "declared": declared,
                                            "absent": collections.Counter(), "seen": 0})
    here = found["containers"][prefix]
    here["seen"] += 1
    present = {k for k in node if k not in RESERVED}
    for key in present - set(declared):
        path = f"{prefix}/{rest.json_pointer_component(key)}" if prefix else \
            rest.json_pointer_component(key)
        found["stale"][path] += 1
        found["at"][path] = prefix
        shown = render(node[key])
        if shown:
            found["staleValues"][path].append(shown)
            twin = repair.superseded_keys(node, set(declared)).get(key)
            if twin:
                found["superseded"][path][twin] += 1
    for key in set(declared) - present:
        here["absent"][key] += 1
    for name, child in element_children(definition).items():
        if name not in node:
            continue
        inner = f"{prefix}/{rest.json_pointer_component(name)}" if prefix else \
            rest.json_pointer_component(name)
        for one in occurrences(node[name]):
            walk_container(one, child, inner, found)


def container_values(node, definition, prefix, into):
    """What each declared name holds, by the same route, read from an instance that validates."""
    declared = [n for n, _c, _m, e in rest.direct_schema_children(definition) if not e]
    for name in declared:
        if name not in node:
            continue
        path = f"{prefix}/{rest.json_pointer_component(name)}" if prefix else \
            rest.json_pointer_component(name)
        shown = render(node[name])
        if shown:
            into[path].append(shown)
    for name, child in element_children(definition).items():
        if name not in node:
            continue
        inner = f"{prefix}/{rest.json_pointer_component(name)}" if prefix else \
            rest.json_pointer_component(name)
        for one in occurrences(node[name]):
            container_values(one, child, inner, into)


def study(template_id, instance_ids):
    template = get(template_id, 'templates')
    if template is None:
        return None
    declared = [n for n, _c, _m, _e in rest.direct_schema_children(template)]
    random.seed(11)
    chosen = random.sample(instance_ids, min(SAMPLE, len(instance_ids)))
    found = {"stale": collections.Counter(), "at": {},
             "staleValues": collections.defaultdict(list),
             "superseded": collections.defaultdict(collections.Counter),
             "containers": {}}
    # A key is asked about only where it still has nowhere to go, so every rename already confirmed
    # is applied first. That is also what puts the inside of a renamed element within reach: until
    # the element itself is settled, there is no declaration to read its children against.
    repair.RENAMES.clear()
    repair.RENAMES.update(SETTLED)
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for body in pool.map(lambda i: get(i, 'template-instances'), chosen):
            if body is None:
                continue
            try:
                body, _changes = repair.rename_instance_keys(body, template)
            except repair.TransformRefused:
                pass
            walk_container(body, template, "", found)
    # What the declared names hold where the template's own instances do validate.
    declared_values = collections.defaultdict(list)
    healthy = VALID.get(template_id, [])[:VALUES * 2]
    if healthy:
        with cf.ThreadPoolExecutor(max_workers=8) as pool:
            for body in pool.map(lambda i: get(i, 'template-instances'), healthy):
                if body is None:
                    continue
                container_values(body, template, "", declared_values)
    absent = found["containers"].get("", {}).get("absent", collections.Counter())
    return {"template": template, "declared": declared, "sampled": len(chosen),
            "instances": len(instance_ids), "stale": found["stale"], "absent": absent,
            "at": found["at"], "containers": found["containers"],
            "staleValues": found["staleValues"], "declaredValues": declared_values,
            "superseded": found["superseded"], "healthy": len(healthy)}

VALID = {}
# Decisions the operator has already given, keyed by template IRI then by the key they ruled on.
# A key answered here is not asked again, however long its rename waits on a sibling.
ANSWERED: dict = {}
# Every rename already confirmed, applied to a sampled instance before it is read, so the sheet
# asks only about what is left. Settling an element is what brings its children into view.
SETTLED: dict = {}


def declared_path(prefix, name):
    """The route to a declared name inside the container at `prefix`."""
    escaped = rest.json_pointer_component(name)
    return f"{prefix}/{escaped}" if prefix else escaped


def candidate_kind(found, prefix, name):
    """Whether a declared name is an element, a field, or something the walk could not read."""
    here = found["containers"].get(prefix)
    if here is None:
        return None
    for child, definition, _multiple, error in rest.direct_schema_children(here["definition"]):
        if child == name:
            return None if error or definition is None else \
                ("element" if repair.is_element(definition) else "field")
    return None


def candidates_for(found, prefix):
    """The declared names a stale key in this container could belong to.

    A name some occurrence of the container already carries is not offered: the field is not the one
    that went missing. Where nothing is unclaimed the whole declaration is offered instead, so a key
    is never left without candidates to weigh.
    """
    here = found["containers"].get(prefix)
    if here is None:
        return []
    unclaimed = [n for n in here["declared"] if here["absent"].get(n)]
    return unclaimed or here["declared"]


def proposals_for(found):
    """Pair every stale key with a declared name, one container at a time.

    A rename is one-to-one within the container it happens in, so the pairing is settled separately
    for each: a key inside an element competes only with the other keys inside that element.
    """
    out = {}
    grouped = collections.defaultdict(list)
    for path in found["stale"]:
        grouped[found["at"].get(path, "")].append(path)
    for prefix, paths in grouped.items():
        names = [path.rsplit("/", 1)[-1] for path in paths]
        by_name = dict(zip(names, paths))
        picked = propose_all(names, candidates_for(found, prefix),
                             {n: found["stale"][by_name[n]] for n in names})
        for name, answer in picked.items():
            out[by_name[name]] = answer
    return out


REGISTRY = HOME / "decision-registry.json"
DECISIONS = pathlib.Path.home() / "Desktop" / "cedar-rename-decisions.md"


def decision_numbers(pending):
    """A stable number per decision, kept in a registry beside the run records.

    Numbering by position makes an answer ambiguous: regenerate the sheet after a repair lands and
    every number below the change shifts, so an answer given against one sheet lands on a different
    question in the next. A decision is identified by the template it belongs to and the key it rules
    on; once numbered it keeps that number, and a number is never reused.
    """
    try:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8")) if REGISTRY.is_file() else {}
    except ValueError:
        registry = {}
    highest = max(registry.values(), default=0)
    for template_id, found, _proposals, undecided in pending:
        for stale, _guess in undecided:
            token = f"{template_id}\t{stale}"
            if token not in registry:
                highest += 1
                registry[token] = highest
    REGISTRY.write_text(json.dumps(registry, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return registry


def load_answered():
    path = HOME / "answers-mapping.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}


def load_written():
    """How many instances of each template a repair run has actually written."""
    written = collections.Counter()
    for name in ("settled-fix.jsonl", "complete-fix.jsonl"):
        path = HOME / name
        if not path.is_file():
            continue
        for line in path.open(encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("outcome") == "repaired" and record.get("templateId"):
                written[record["templateId"]] += 1
    return written


def load_valid_instances():
    """Instances of these templates that already validate, as a source of current values."""
    wanted = set(json.load(open(HOME / 'top10-residual.json')))
    out = collections.defaultdict(list)
    for line in open(HOME / 'production-validation.jsonl'):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        validation = record.get("validation") or {}
        if record.get("artifactType") == "instance" and validation.get("status") == "valid" \
                and validation.get("templateId") in wanted:
            out[validation["templateId"]].append(record["artifactId"])
    return out


def main():
    VALID.update(load_valid_instances())
    ANSWERED.update(load_answered())
    SETTLED.update(settled_mapping())
    written = load_written()
    residual = json.load(open(HOME / 'top10-residual.json'))
    out = ["# CEDAR — Template Rename Review",
           "",
           "Ten templates carry two thirds of the invalid instances left in production. Each was edited "
           "after instances had been created against it, and the edits renamed fields without touching "
           "the instances. An instance therefore carries a key its template no longer declares, and the "
           "template declares one the instance never had.",
           "",
           "Every pairing below is a **proposal, not a finding**. Where a template renamed several fields "
           "at once, nothing in the stored artifacts says which old name became which new one; the "
           "proposals are ranked by wording and spelling, and only an owner can confirm them.",
           "",
           "Dates are the template's own `pav:createdOn` and `pav:lastUpdatedOn`. Sampling is up to "
           f"{SAMPLE} invalid instances per template.",
           "",
           "A key marked **superseded** repeats the same value under the same explicit property "
           "IRI. Other proposed pairings require a recorded decision, even when names differ only "
           "in spelling or their values overlap. Such similarities do not establish a rename. "
           "Confidence combines how strongly the wording and spelling agree with how many instances "
           "carry the key, so a name used once does not outbid one used throughout. It is not a "
           "probability that the rename happened. "
           "A **weak** pairing is a guess offered so the right answer is easy to spot; treat it as a "
           "question, not a recommendation. Where no pairing is offered, the unmatched declared names "
           "listed under the table are the candidates.",
           ""]
    total = 0
    summary = []
    sections = []
    studies = []
    for rank, (template_id, instance_ids) in enumerate(
            sorted(residual.items(), key=lambda kv: -len(kv[1])), 1):
        found = study(template_id, instance_ids)
        if found is None:
            continue
        studies.append((rank, template_id, found))
        t0 = found["template"]
        summary.append(f"| {rank} | {t0.get('schema:name') or '(unnamed)'} | {found['instances']} | "
                       f"{str(t0.get('pav:createdOn') or '')[:10]} | "
                       f"{str(t0.get('pav:lastUpdatedOn') or '')[:10]} | {len(found['stale'])} |")
    out += ["## The Ten", "",
            "| # | Template | Invalid instances | Created | Last modified | Stale keys |",
            "| --- | --- | --- | --- | --- | --- |"] + summary + [""]
    for rank, template_id, found in studies:
        t = found["template"]
        total += found["instances"]
        out += [f"## {rank}. {t.get('schema:name') or '(unnamed)'}", ""]
        out += [f"- **Invalid instances**: {found['instances']} (sampled {found['sampled']})",
                f"- **Description**: {t.get('schema:description') or '_none_'}",
                f"- **Created**: {t.get('pav:createdOn') or '_unknown_'}",
                f"- **Last modified**: {t.get('pav:lastUpdatedOn') or '_unknown_'}",
                f"- **Version / status**: {t.get('pav:version') or '?'} / "
                f"{(t.get('bibo:status') or '?').replace('bibo:', '')}",
                f"- **Identifier**: `{template_id}`",
                f"- **Fields declared**: {len(found['declared'])}",
                f"- **Valid instances to compare against**: "
                + (f"{found['healthy']}" if found['healthy'] else
                   "**none** — no value comparison is possible for this template, so every pairing "
                   "below rests on the names alone"),
                ""]
        if not found["stale"]:
            out += ["No instance carries a key this template does not declare, so nothing here is a "
                    "rename. These instances fail for another reason.", ""]
            continue
        proposals = proposals_for(found)
        unclaimed = candidates_for(found, "")
        settled, rows = [], []
        for stale, count in found["stale"].most_common():
            name, basis, value = proposals[stale]
            shown = f"`{name}`" if name else "_no candidate_"
            confidence = ("high" if value >= 0.7 else "moderate" if value >= 0.5
                          else "weak — check first" if name else "—")
            answered_as = (ANSWERED.get(template_id) or {}).get(stale, "")
            twin = supersedes(found, stale, count)
            if stale in (ANSWERED.get(template_id) or {}):
                shown = (f"`{answered_as}`" if answered_as else "_delete_")
                basis, confidence = "you answered", "settled"
                settled.append(stale)
            elif twin:
                shown, basis, confidence = f"`{twin}` (already present)", "superseded", "settled"
                settled.append(stale)
            rows.append((stale, shown, basis, confidence, count))
        blocked = [s for s in found["stale"] if s not in settled]
        done = written.get(template_id, 0)
        if blocked:
            out += [f"**Nothing can be written for this template yet.** {len(settled)} of "
                    f"{len(found['stale'])} keys are settled, but an instance is only written once "
                    f"it fully validates, so the settled renames wait on the rest: "
                    + ", ".join(f"`{s}`" for s in blocked) + ".", ""]
        elif done:
            out += [f"**{done} instances written.** Every key here is settled; what remains invalid "
                    "fails for some other reason.", ""]
        out += ["| Key the instances carry | Proposed current name | Basis | Status | Instances |",
                "| --- | --- | --- | --- | --- |"]
        for stale, shown, basis, confidence, count in rows:
            status = confidence if confidence != "settled" else (
                "settled — applied" if not blocked and done else "settled — waiting")
            out += [f"| `{stale}` | {shown} | {basis} | {status} | {count} |"]
        out += [""]
        leftover = [n for n in unclaimed
                    if n not in {p[0] for p in proposals.values() if p[0]}]
        out += ["<details><summary>What the values look like</summary>", ""]
        for stale, _count in found["stale"].most_common():
            name = proposals[stale][0]
            out += [f"**`{stale}`** — carried by {_count} of the sampled instances:", ""]
            samples = tidy(found["staleValues"].get(stale, []))
            out += ([f"- {s}" for s in samples] if samples
                    else ["- _every sampled instance leaves it empty_"]) + [""]
            if name:
                current = tidy(found["declaredValues"].get(
                    declared_path(found["at"].get(stale, ""), name), []))
                out += [f"**`{name}`** — what instances that do validate carry:", ""]
                out += ([f"- {s}" for s in current] if current
                        else [f"- _no valid instance of this template carries a value here"
                              f" ({found['healthy']} checked)_"]) + [""]
        out += ["</details>", ""]
        if leftover_values := [n for n in (unclaimed or [])
                               if n not in {pr[0] for pr in proposals.values() if pr[0]}]:
            out += ["<details><summary>Declared fields still unclaimed, and what they hold</summary>",
                    "",
                    "Where a key above has no candidate, or a weak one, these are what it might "
                    "belong to. The values come from instances of this template that already "
                    "validate.", ""]
            for name in leftover_values:
                samples = tidy(found["declaredValues"].get(declared_path("", name), []))
                out += [f"**`{name}`**", ""]
                out += ([f"- {s}" for s in samples] if samples
                        else [f"- _no valid instance carries a value here "
                              f"({found['healthy']} checked)_"]) + [""]
            out += ["</details>", ""]
        if leftover:
            out += [f"Declared fields no stale key was matched to: "
                    + ", ".join(f"`{n}`" for n in leftover), ""]
    # The per-template review this loop assembles is not written out: the decision list is the only
    # document anyone reads, and a second view of the same data was more confusing than useful.
    print(f"studied {len(studies)} templates covering {total} invalid instances")
    write_settled(studies)
    write_decisions(studies, written)


def write_settled(studies):
    """Clear heuristic-only mappings; only recorded owner answers authorize a rename."""
    settled = {}
    path = HOME / "settled-mapping.json"
    path.write_text(json.dumps(settled, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    count = sum(len(m) for m in settled.values())
    print(f"wrote {path}: no automatically approved renames; proposals require recorded decisions")


def write_decisions(studies, written):
    """One line per decision, grouped so the answers are read once and used many times.

    Every key in the same container competes for the same declared names, so the lettered answers
    belong to the container rather than to each question. Stating them once turns a decision into a
    single line: the key, what it holds, and a blank.
    """
    pending = []
    for _rank, template_id, found in studies:
        proposals = proposals_for(found)
        answered = ANSWERED.get(template_id) or {}
        undecided = []
        for stale in found["stale"]:
            if stale in answered:
                continue
            name, basis, _value = proposals[stale]
            if supersedes(found, stale, found["stale"][stale]):
                continue
            undecided.append((stale, name))
        if undecided:
            pending.append((template_id, found, proposals, undecided))

    scope = {}
    path = HOME / "residual-scope.json"
    if path.is_file():
        try:
            scope = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            scope = {}
    registry = decision_numbers(pending)
    questions = sum(len(p[3]) for p in pending)

    lines = ["# CEDAR — Rename Decisions",
             "",
             f"**{questions} questions across {len(pending)} templates.** Each instance carries a key "
             "its template no longer declares. Say where the value goes.",
             ""]
    if scope:
        lines += [f"Production holds {scope['total']} invalid instances across {scope['templates']} "
                  f"templates. The {len(studies)} studied here — those with the most instances "
                  f"waiting on a rename — hold {scope['covered']} of them. Anything settled by "
                  "matching names or matching values, and anything you have already answered, is "
                  "left out.", ""]
    lines += ["## How to Answer",
              "",
              "Write a letter in the last column. The letters are listed once per group and mean the "
              "same for every question in it. Two are always there: **delete** where the value is "
              "recorded elsewhere or no longer wanted, and **keep** where the template is what "
              "should change. A letter in bold is the closest match on wording, which is a hint and "
              "not a recommendation.",
              "",
              "A key written with a slash sits inside an element — `DataCite Title/titleLanguage` is "
              "`titleLanguage` inside the element the template declares as `DataCite Title` — and "
              "its answers are that element's own fields. An answer marked *elem* names an element "
              "rather than a field: a value cannot be renamed into one, so choosing it records where "
              "the value belongs without moving it.",
              "",
              "Numbers belong to one question for good, so they run out of order and the sequence "
              "has gaps where you have already answered. Groups are ordered by what releases most "
              "for least effort.",
              "",
              "A template releases nothing until **every** question under it is answered.",
              ""]

    order = sorted(pending, key=lambda p: (len(p[3]) / max(1, p[1]["instances"])))
    for template_id, found, proposals, undecided in order:
        title = found["template"].get("schema:name") or "(unnamed)"
        pending_here = dict(undecided)
        grouped = collections.defaultdict(list)
        for stale, guess in undecided:
            grouped[found["at"].get(stale, "")].append((stale, guess))
        lines += [f"### {title} — {found['instances']} instances, {len(undecided)} to answer", ""]
        for prefix, rows in sorted(grouped.items()):
            claimed = {answer[0] for path_, answer in proposals.items()
                       if answer[0] and path_ not in pending_here
                       and found["at"].get(path_, "") == prefix}
            options = [n for n in candidates_for(found, prefix) if n not in claimed]
            letters = answer_letters(options)
            guesses = {guess for _stale, guess in rows}
            if prefix:
                lines += [f"Inside the element `{prefix}`:", ""]
            offered = []
            for letter, choice in letters:
                mark = ""
                if choice not in ("delete", "keep") and \
                        candidate_kind(found, prefix, choice) == "element":
                    mark = " *elem*"
                shown = f"**{letter}** {choice}{mark}" if choice in guesses else \
                    f"{letter} {choice}{mark}"
                offered.append(shown)
            offered.append("Z something else")
            lines += ["Answers: " + " · ".join(offered), "",
                      "| # | Key the instances carry | What it holds | ✎ |",
                      "| --- | --- | --- | --- |"]
            for stale, _guess in sorted(rows, key=lambda r: registry[f"{template_id}\t{r[0]}"]):
                number = registry[f"{template_id}\t{stale}"]
                key = stale.rsplit("/", 1)[-1] if prefix else stale
                held = distinct(found["staleValues"].get(stale, []), 3)
                shown = "; ".join(elide(v, 34) for v in held) if held else "_always empty_"
                lines.append(f"| **{number}** | `{key}` | {elide(shown, 78)} | |")
            lines += [""]

    path = DECISIONS
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes): {questions} decisions "
          f"across {len(pending)} templates")


main()
