#!/usr/bin/env python3
"""Aggregate multilingual-label coverage across every snapshot in a catalog.

Usage: label-coverage.py <catalog.sqlite> [logfile]
Reads each snapshot's label/meta tables and reports: how many snapshots were backfilled, total
label rows, language and property histograms, and how many ontologies carry more than one language.
If a backfill logfile is given, it also tallies the content-drift skips.
"""
import sqlite3, sys, os, collections

catalog = sys.argv[1]
logfile = sys.argv[2] if len(sys.argv) > 2 else None
base = os.path.dirname(os.path.abspath(catalog))

cat = sqlite3.connect(catalog)
rows = cat.execute(
    "SELECT acronym, file_path FROM snapshot WHERE backend='bioportal'").fetchall()
cat.close()

snap_total = len(rows)
snap_backfilled = 0        # carry the labels_backfilled marker
snap_with_labels = 0       # have >=1 real label row
snap_multilang = 0         # >1 distinct language
snap_missing_file = 0
total_labels = 0
lang_hist = collections.Counter()
prop_hist = collections.Counter()
per_ont_langs = {}

for acronym, rel in rows:
    path = rel if os.path.isabs(rel) else os.path.join(base, rel)
    if not os.path.exists(path):
        snap_missing_file += 1
        continue
    c = sqlite3.connect(path)
    try:
        has_marker = c.execute(
            "SELECT 1 FROM meta WHERE key='labels_backfilled'").fetchone() is not None
    except sqlite3.OperationalError:
        has_marker = False
    if has_marker:
        snap_backfilled += 1
    try:
        n = 0
        langs = set()
        for prop, lang, cnt in c.execute(
                "SELECT property, lang, COUNT(*) FROM label GROUP BY property, lang"):
            total_labels += cnt
            n += cnt
            lang_hist[lang or "(none)"] += cnt
            prop_hist[prop] += cnt
            langs.add(lang or "")
        if n:
            snap_with_labels += 1
        real_langs = {l for l in langs if l}
        if len(real_langs) > 1:
            snap_multilang += 1
            per_ont_langs[acronym] = sorted(real_langs)
    except sqlite3.OperationalError:
        pass
    c.close()

print(f"snapshots (bioportal):     {snap_total}")
print(f"  backfilled (marked done):{snap_backfilled}")
print(f"  with >=1 real label:     {snap_with_labels}")
print(f"  multilingual (>1 lang):  {snap_multilang}")
print(f"  snapshot file missing:   {snap_missing_file}")
print(f"total label rows:          {total_labels:,}")

print("\nlanguages (top 20 by rows):")
for lang, cnt in lang_hist.most_common(20):
    print(f"  {lang:>8}  {cnt:>10,}")

print("\nproperties:")
for prop, cnt in sorted(prop_hist.items(), key=lambda kv: -kv[1]):
    print(f"  {prop:<26} {cnt:>10,}")

if per_ont_langs:
    print(f"\nmultilingual ontologies (sample of {min(20, len(per_ont_langs))} of {len(per_ont_langs)}):")
    for acr in sorted(per_ont_langs)[:20]:
        print(f"  {acr:<18} {','.join(per_ont_langs[acr][:12])}")

if logfile and os.path.exists(logfile):
    drift = sum(1 for l in open(logfile) if 'hashed to' in l and ' not ' in l)
    fails = sum(1 for l in open(logfile) if l.startswith('FAIL '))
    print(f"\nfrom log: {drift} content-drift skips, {fails} external failures")
