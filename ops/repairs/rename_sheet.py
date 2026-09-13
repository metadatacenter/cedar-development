#!/usr/bin/env python3
"""Draft the rename mapping a template's instances imply, for an owner to confirm."""
import json, os, pathlib, urllib.request, urllib.parse, sys, importlib.util, collections, random, re, difflib
import concurrent.futures as cf

OPS = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path(os.environ.get("CEDAR_HOME", pathlib.Path.home() / "CEDAR"))
spec = importlib.util.spec_from_file_location("cedar_artifact_rest_audit",
                                              OPS / "cedar_artifact_rest_audit.py")
rest = importlib.util.module_from_spec(spec); sys.modules[spec.name] = rest; spec.loader.exec_module(rest)
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
    if "@id" in value:
        label = value.get("rdfs:label") or value.get("skos:prefLabel")
        return str(label) if label else str(value["@id"]).rsplit("/", 1)[-1]
    if depth >= 1:
        return None
    inner = [f"{k}={render(v, depth + 1)}" for k, v in value.items()
             if not k.startswith("@") and render(v, depth + 1)]
    return "{" + ", ".join(inner[:3]) + "}" if inner else None


def shared_values(found, stale, name):
    """Whether the two names hold values in common.

    A value carried under the old name and under the new one, in instances of the same template, is
    the two names describing one field. It settles a pairing that wording alone only suggests.
    """
    old = {v for v in (found["staleValues"].get(stale) or []) if len(v) > 2}
    new = {v for v in (found["declaredValues"].get(name) or []) if len(v) > 2}
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


def study(template_id, instance_ids):
    template = get(template_id, 'templates')
    if template is None:
        return None
    declared = [n for n, _c, _m, _e in rest.direct_schema_children(template)]
    random.seed(11)
    chosen = random.sample(instance_ids, min(SAMPLE, len(instance_ids)))
    stale = collections.Counter()
    absent = collections.Counter()
    stale_values = collections.defaultdict(list)
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for body in pool.map(lambda i: get(i, 'template-instances'), chosen):
            if body is None:
                continue
            present = {k for k in body if k not in RESERVED}
            for k in present - set(declared):
                stale[k] += 1
                shown = render(body[k])
                if shown:
                    stale_values[k].append(shown)
            for k in set(declared) - present:
                absent[k] += 1
    # What the declared names hold where the template's own instances do validate.
    declared_values = collections.defaultdict(list)
    healthy = VALID.get(template_id, [])[:VALUES * 2]
    if healthy:
        with cf.ThreadPoolExecutor(max_workers=8) as pool:
            for body in pool.map(lambda i: get(i, 'template-instances'), healthy):
                if body is None:
                    continue
                for k in declared:
                    if k in body:
                        shown = render(body[k])
                        if shown:
                            declared_values[k].append(shown)
    return {"template": template, "declared": declared, "sampled": len(chosen),
            "instances": len(instance_ids), "stale": stale, "absent": absent,
            "staleValues": stale_values, "declaredValues": declared_values,
            "healthy": len(healthy)}


VALID = {}


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
           "A pairing marked **confirmed by data** is one where the same value appears under both "
           "names in instances of this template: that is the two names describing one field, and "
           "needs no judgement. Everything else is a proposal. "
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
                ""]
        if not found["stale"]:
            out += ["No instance carries a key this template does not declare, so nothing here is a "
                    "rename. These instances fail for another reason.", ""]
            continue
        out += ["| Key the instances carry | Proposed current name | Basis | Confidence | Instances | Confirm |",
                "| --- | --- | --- | --- | --- | --- |"]
        unclaimed = [n for n in found["declared"] if n in found["absent"]]
        proposals = propose_all(list(found["stale"]), unclaimed or found["declared"],
                                dict(found["stale"]))
        for stale, count in found["stale"].most_common():
            name, basis, value = proposals[stale]
            shown = f"`{name}`" if name else "_no candidate_"
            confidence = ("high" if value >= 0.7 else "moderate" if value >= 0.5
                          else "weak — check first" if name else "—")
            if name and shared_values(found, stale, name):
                basis, confidence = "same values", "**confirmed by data**"
            out += [f"| `{stale}` | {shown} | {basis} | {confidence} | {count} | ☐ |"]
        out += [""]
        out += ["<details><summary>What the values look like</summary>", ""]
        for stale, _count in found["stale"].most_common():
            name = proposals[stale][0]
            out += [f"**`{stale}`** — carried by {_count} of the sampled instances:", ""]
            samples = tidy(found["staleValues"].get(stale, []))
            out += ([f"- {s}" for s in samples] if samples
                    else ["- _every sampled instance leaves it empty_"]) + [""]
            if name:
                current = tidy(found["declaredValues"].get(name, []))
                out += [f"**`{name}`** — what instances that do validate carry:", ""]
                out += ([f"- {s}" for s in current] if current
                        else [f"- _no valid instance of this template carries a value here"
                              f" ({found['healthy']} checked)_"]) + [""]
        out += ["</details>", ""]
        leftover = [n for n in unclaimed
                    if n not in {p[0] for p in proposals.values() if p[0]}]
        if leftover:
            out += [f"Declared fields no stale key was matched to: "
                    + ", ".join(f"`{n}`" for n in leftover), ""]
    out.insert(6, f"Covering **{total} invalid instances**.")
    out.insert(7, "")
    path = pathlib.Path.home() / "Desktop" / "cedar-template-rename-review.md"
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes), covering {total} instances")


main()
