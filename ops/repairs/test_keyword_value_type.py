"""Dropping "@type": "@id" from values changes nothing else, and leaves contexts and classes alone."""
import copy
import unittest

import cedar_artifact_repair as r


class KeywordValueTypeTest(unittest.TestCase):
    def setUp(self):
        self.instance = {
            "@id": "urn:instance", "schema:isBasedOn": "urn:template", "schema:name": "keep",
            "pav:createdOn": "2016-10-01T10:00:00-07:00", "pav:lastUpdatedOn": "2017-02-01T10:00:00-08:00",
            "@context": {"pav:createdBy": {"@type": "@id"}, "Term": {"@id": "urn:p", "@type": "@id"}},
            "Term": {"@id": "urn:t", "@type": "@id", "rdfs:label": "a term"},
            "Empty": {"@id": None, "@type": "@id"},
            "Classed": {"@id": "urn:t", "@type": "urn:class", "rdfs:label": "a term"},
            "Literal": {"@value": "1", "@type": "xsd:int"},
            "Element": {"@id": "urn:e", "@context": {"Terms": {"@type": "@id"}},
                        "Terms": [{"@id": "urn:t", "@type": "@id"}, {"@id": "urn:u"}]},
        }

    def test_drops_only_the_keyword_and_is_idempotent(self):
        stored = copy.deepcopy(self.instance)
        after, changes = r.drop_keyword_value_types(self.instance)

        self.assertEqual(self.instance, stored)
        self.assertEqual(sorted(change["path"] for change in changes),
                         ["/Element/Terms/0/@type", "/Empty/@type", "/Term/@type"])
        self.assertEqual(after["Term"], {"@id": "urn:t", "rdfs:label": "a term"})
        self.assertEqual(after["Empty"], {"@id": None})
        self.assertEqual(after["Element"]["Terms"], [{"@id": "urn:t"}, {"@id": "urn:u"}])
        for kept in ("@context", "Classed", "Literal", "pav:createdOn", "pav:lastUpdatedOn", "schema:name"):
            self.assertEqual(after[kept], self.instance[kept])
        self.assertEqual(after["Element"]["@context"], self.instance["Element"]["@context"])
        self.assertIsNone(r.only_dropped_keyword_value_types(self.instance, after))
        self.assertEqual(r.drop_keyword_value_types(after), (after, []))

    def test_invariant_refuses_any_other_difference(self):
        after, _ = r.drop_keyword_value_types(self.instance)
        for pointer, mutate in (
            ("/pav:lastUpdatedOn", lambda x: x.update(**{"pav:lastUpdatedOn": "2026-10-23T00:00:00Z"})),
            ("/Term/rdfs:label", lambda x: x["Term"].pop("rdfs:label")),
            ("/Classed/@type", lambda x: x["Classed"].pop("@type")),
            ("/Literal/@type", lambda x: x["Literal"].pop("@type")),
            ("/@context/Term/@type", lambda x: x["@context"]["Term"].pop("@type")),
            ("/Element/@context/Terms/@type", lambda x: x["Element"]["@context"]["Terms"].pop("@type")),
        ):
            with self.subTest(pointer=pointer):
                changed = copy.deepcopy(after)
                mutate(changed)
                self.assertEqual(r.only_dropped_keyword_value_types(self.instance, changed), pointer)

    def test_registered_against_the_audit_condition(self):
        repair = r.REPAIRS["drop-keyword-value-type"]
        self.assertEqual(repair.conditions, ("value-type-keyword",))
        self.assertFalse(repair.needs_template)
        self.assertEqual(r.apply_repairs([repair], self.instance)[0], r.drop_keyword_value_types(self.instance)[0])


if __name__ == "__main__":
    unittest.main()
