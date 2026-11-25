#!/usr/bin/env python3
"""
cedar_dependency_order_check.py — declare used-undeclared dependencies without changing which jar wins.

A module's classes can use an artifact that only reaches the module through another dependency.
Declaring it moves it, and everything beneath it, to a new place in the classpath order of every
module that consumes the declaring one. A declaration stands only when, across the cedar-project
reactor, no resolved artifact, version or scope changes, and no two jars that the order decides
between change places: two jars holding the same class or resource, or registering different
providers of a service whose consumers take the first. A swap of jars that share only a package,
a resource read by nothing at runtime or read as every copy, or a service whose consumers load
every provider, cannot change what runs, and is allowed.

  plan   ANALYZE_LOG EFFECTIVE_POM TREES_DIR CEDAR_HOME OUT_PLAN
         ANALYZE_LOG is `mvn dependency:analyze-only` over cedar-project, EFFECTIVE_POM is
         cedar-parent's `help:effective-pom`, TREES_DIR holds `dependency:tree -DoutputType=json`
         per module. Plans one declaration per used-undeclared artifact that the parent versions,
         directly after the direct dependency that already brings it.
  apply  PLAN [EXCLUDE_FILE]   insert the planned declarations, less the excluded ids, into the POMs
  check  PLAN BEFORE_DIR AFTER_DIR OUT [EXCLUDE_FILE]
         BEFORE_DIR and AFTER_DIR each hold tree/<module>.json and cp/<module>.txt, the latter from
         `dependency:build-classpath -Dmdep.includeScope=test`. Reports resolution changes and every
         clashing swap, with the applied declarations on the path that moved either jar.

Withdraw what `check` blames, apply again from clean POMs and repeat until nothing is blamed.
"""
import collections
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://maven.apache.org/POM/4.0.0"}


# ---------------------------------------------------------------- shared helpers

def ga(node):
    return f"{node['groupId']}:{node['artifactId']}"


def walk(node, depth=0):
    yield node, depth
    for child in node.get("children", []):
        yield from walk(child, depth + 1)


def subtree_has(node, key):
    return any(ga(n) == key for n, _ in walk(node))


def load_tree(path):
    with open(path) as f:
        return json.load(f)


def module_poms(cedar_home, reactor_dirs):
    """artifactId -> pom path for every module under the reactor's repositories."""
    found = {}
    for repo in reactor_dirs:
        for dirpath, dirnames, filenames in os.walk(os.path.join(cedar_home, repo)):
            dirnames[:] = [d for d in dirnames if d not in ("target", "node_modules", ".git", "src")]
            if "pom.xml" in filenames:
                path = os.path.join(dirpath, "pom.xml")
                root = ET.parse(path).getroot()
                aid = root.find("m:artifactId", NS)
                if aid is not None:
                    found[aid.text] = path
    return found


# ---------------------------------------------------------------- plan

def plan(analyze_log, effective_pom, trees_dir, cedar_home, out):
    root = ET.parse(effective_pom).getroot()
    managed = {(d.find("m:groupId", NS).text, d.find("m:artifactId", NS).text)
               for d in root.findall("m:dependencyManagement/m:dependencies/m:dependency", NS)}
    pairs, module, section = [], None, False
    for line in open(analyze_log):
        line = re.sub(r"^\[[A-Z]+\]\s?", "", line.rstrip())
        m = re.search(r"analyze-only .* @ (\S+) ---", line)
        if m:
            module, section = m.group(1), False
            continue
        if line.startswith("Used undeclared dependencies found"):
            section = True
            continue
        if section:
            m = re.match(r"\s+([\w.\-]+):([\w.\-]+):\w+:([^:]+):(\w+)", line)
            if m:
                pairs.append((module,) + m.groups())
            else:
                section = False
    project = ET.parse(os.path.join(cedar_home, "cedar-project", "pom.xml")).getroot()
    reactor = [os.path.basename(m.text) for m in project.iter(f"{{{NS['m']}}}module")]
    poms = module_poms(cedar_home, reactor)
    entries, skipped = [], collections.Counter()
    for mod, g, a, v, scope in pairs:
        if g.startswith("org.junit"):
            skipped["junit aggregator"] += 1
            continue
        if (g, a) not in managed:
            skipped["no managed version"] += 1
            continue
        tree = load_tree(os.path.join(trees_dir, f"{mod}.json"))
        key = f"{g}:{a}"
        anchor = next((c for c in tree["children"] if subtree_has(c, key)), None)
        resolved = next((n for n, d in walk(tree) if d > 0 and ga(n) == key), None)
        if anchor is None or resolved is None:
            skipped["not in tree"] += 1
            continue
        entries.append({
            "id": f"{mod}|{key}",
            "module": mod,
            "pom": poms.get(mod),
            "groupId": g,
            "artifactId": a,
            "scope": resolved["scope"],
            "anchor": ga(anchor),
        })
    with open(out, "w") as f:
        json.dump(entries, f, indent=1)
    print(len(entries), "planned;", dict(skipped), "; missing pom:", sum(1 for e in entries if not e["pom"]))


# ---------------------------------------------------------------- apply

DEP_BLOCK = re.compile(r"([ \t]*)<dependency>\s*<groupId>([^<]+)</groupId>\s*<artifactId>([^<]+)</artifactId>.*?</dependency>\n",
                       re.S)


def project_dependencies_span(text):
    """The span of the project's own <dependencies>, outside dependencyManagement, plugins and profiles."""
    masked = text
    for tag in ("dependencyManagement", "plugins", "pluginManagement", "profiles"):
        masked = re.sub(rf"<{tag}>.*?</{tag}>", lambda m: " " * len(m.group(0)), masked, flags=re.S)
    m = re.search(r"<dependencies>.*?</dependencies>", masked, re.S)
    return (m.start(), m.end()) if m else None


def apply(plan_path, exclude_path=None):
    entries = json.load(open(plan_path))
    exclude = set(open(exclude_path).read().split("\n")) if exclude_path else set()
    by_pom = collections.defaultdict(list)
    for e in entries:
        if e["id"] not in exclude:
            by_pom[e["pom"]].append(e)
    placed, unplaced = 0, []
    for pom, items in by_pom.items():
        text = open(pom).read()
        for e in items:
            span = project_dependencies_span(text)
            if span is None:
                unplaced.append(e["id"])
                continue
            start, end = span
            target = None
            for m in DEP_BLOCK.finditer(text, start, end):
                if f"{m.group(2).strip()}:{m.group(3).strip()}" == e["anchor"]:
                    target = m
                    break
            if target is None:
                unplaced.append(e["id"])
                continue
            indent = target.group(1)
            inner = indent + "  "
            block = (f"{indent}<dependency>\n{inner}<groupId>{e['groupId']}</groupId>\n"
                     f"{inner}<artifactId>{e['artifactId']}</artifactId>\n")
            if e["scope"] and e["scope"] != "compile":
                block += f"{inner}<scope>{e['scope']}</scope>\n"
            block += f"{indent}</dependency>\n"
            text = text[:target.end()] + block + text[target.end():]
            placed += 1
        open(pom, "w").write(text)
    print("placed", placed, "unplaced", len(unplaced))
    for u in unplaced:
        print("  unplaced:", u)


# ---------------------------------------------------------------- check

IGNORED_RESOURCE = re.compile(
    r"^(META-INF/(MANIFEST\.MF|INDEX\.LIST|DEPENDENCIES|LICENSE.*|NOTICE.*|README.*|maven/.*|[^/]*\.(SF|RSA|DSA|EC)"
    r"|versions/\d+/module-info\.class|.*\.kotlin_module|services/.*"
    # Read by nothing at runtime, or read as every copy on the classpath.
    r"|PublicApi\.txt|io\.netty\.versions\.properties|native-image/.*|versions/\d+/OSGI-INF/MANIFEST\.MF|proguard/.*"
    r"|org/apache/logging/log4j/core/config/plugins/Log4j2Plugins\.dat|AL2\.0|LGPL2\.1)|module-info\.class|(LICENSE|NOTICE|README|"
    r"license|notice|readme)(\.[a-z]+)?|about\.html|.*/package\.html|.*/$)$")
# Services whose consumers use the first provider, or whose consumers are unidentified and so are
# assumed to.
SINGLE_PROVIDER = {
    "jakarta.ws.rs.ext.RuntimeDelegate", "javax.ws.rs.ext.RuntimeDelegate", "jakarta.ws.rs.client.ClientBuilder",
    "jakarta.ws.rs.sse.SseEventSource$Builder", "jakarta.json.spi.JsonProvider", "javax.json.spi.JsonProvider",
    "jakarta.xml.bind.JAXBContextFactory", "javax.xml.bind.JAXBContext", "jakarta.el.ExpressionFactory",
    "jakarta.validation.spi.ValidationProvider", "org.slf4j.spi.SLF4JServiceProvider",
    "javax.xml.parsers.DocumentBuilderFactory", "javax.xml.parsers.SAXParserFactory",
    "javax.xml.transform.TransformerFactory", "javax.xml.stream.XMLInputFactory", "javax.xml.stream.XMLOutputFactory",
    "javax.xml.stream.XMLEventFactory", "javax.xml.datatype.DatatypeFactory", "javax.xml.xpath.XPathFactory",
    "org.apache.commons.logging.LogFactory", "jakarta.persistence.spi.PersistenceProvider",
    "java.sql.Driver",
}
_jar_cache = {}


def jar_index(path):
    if path in _jar_cache:
        return _jar_cache[path]
    entries, services = set(), {}
    if path.endswith(".jar") and os.path.isfile(path):
        try:
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    if name.startswith("META-INF/services/") and not name.endswith("/"):
                        lines = [l.split("#")[0].strip() for l in z.read(name).decode("utf-8", "replace").splitlines()]
                        services[name[len("META-INF/services/"):]] = {l for l in lines if l}
                    elif not IGNORED_RESOURCE.match(name):
                        entries.add(name)
        except zipfile.BadZipFile:
            pass
    _jar_cache[path] = (entries, services)
    return _jar_cache[path]


def clash(a, b):
    """What two jars hold that their order decides: shared classes and resources, single-provider services."""
    ea, sa = jar_index(a)
    eb, sb = jar_index(b)
    shared = ea & eb
    reasons = []
    classes = sorted(n for n in shared if n.endswith(".class"))
    resources = sorted(n for n in shared if not n.endswith(".class"))
    if classes:
        reasons.append(f"{len(classes)} classes, e.g. {classes[0]}")
    if resources:
        reasons.append(f"{len(resources)} resources, e.g. {resources[0]}")
    for svc in sorted(set(sa) & set(sb)):
        if svc in SINGLE_PROVIDER and sa[svc] != sb[svc]:
            reasons.append(f"service {svc}")
    return reasons


def flat(tree):
    return sorted(f"{ga(n)}:{n['version']}:{n['scope']}:{n['classifier']}" for n, d in walk(tree) if d > 0)


def ancestors(tree, key):
    """Every artifact on the path from the module to `key`, `key` included."""
    out = set()

    def rec(node, path):
        here = path + [ga(node)]
        if ga(node) == key:
            out.update(here[1:])
        for c in node.get("children", []):
            rec(c, here)
    rec(tree, [])
    return out


def check(plan_path, before, after, out, exclude_path=None):
    exclude = set(open(exclude_path).read().split("\n")) if exclude_path else set()
    entries = [e for e in json.load(open(plan_path)) if e["id"] not in exclude]
    by_module = collections.defaultdict(list)
    for e in entries:
        by_module[e["module"]].append(e)
    report = {"resolution": {}, "clashes": [], "blamed": collections.Counter(), "harmless_swaps": 0}
    for name in sorted(os.listdir(os.path.join(before, "tree"))):
        mod = name[:-5]
        tb = load_tree(os.path.join(before, "tree", name))
        ta = load_tree(os.path.join(after, "tree", name))
        fb, fa = flat(tb), flat(ta)
        if fb != fa:
            report["resolution"][mod] = {"lost": sorted(set(fb) - set(fa)), "gained": sorted(set(fa) - set(fb))}
        cpb = open(os.path.join(before, "cp", mod + ".txt")).read().strip().split(":")
        cpa = open(os.path.join(after, "cp", mod + ".txt")).read().strip().split(":")
        pos_a = {p: i for i, p in enumerate(cpa)}
        common = [p for p in cpb if p in pos_a]
        # Upstream CEDAR modules whose declarations reach this one.
        upstream = {mod} | {n["artifactId"] for n, d in walk(ta) if d > 0 and n["groupId"] == "org.metadatacenter"}
        for i in range(len(common)):
            for j in range(i + 1, len(common)):
                x, y = common[i], common[j]
                if pos_a[x] < pos_a[y]:
                    continue
                reasons = clash(x, y)
                if not reasons:
                    report["harmless_swaps"] += 1
                    continue
                kx = jar_key(x, ta)
                ky = jar_key(y, ta)
                path_x = ancestors(ta, kx) if kx else set()
                path_y = ancestors(ta, ky) if ky else set()
                culprits = sorted(e["id"] for m in upstream for e in by_module.get(m, [])
                                  if f"{e['groupId']}:{e['artifactId']}" in (path_x | path_y))
                report["clashes"].append({"module": mod, "first_before": os.path.basename(x),
                                          "first_after": os.path.basename(y), "reasons": reasons,
                                          "culprits": culprits})
                for c in culprits:
                    report["blamed"][c] += 1
    with open(out, "w") as f:
        json.dump(report, f, indent=1)
    print("modules with resolution changes:", len(report["resolution"]))
    print("clashing swaps:", len(report["clashes"]), " harmless swaps:", report["harmless_swaps"])
    print("declarations blamed:", len(report["blamed"]))
    unblamed = [c for c in report["clashes"] if not c["culprits"]]
    print("clashes with no culprit:", len(unblamed))


def jar_key(path, tree):
    base = os.path.basename(path)
    for n, d in walk(tree):
        if d > 0:
            stem = f"{n['artifactId']}-{n['version']}"
            if base.startswith(stem) and (n["classifier"] == "" or n["classifier"] in base):
                return ga(n)
    return None


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"plan": plan, "apply": apply, "check": check}[cmd](*args)
