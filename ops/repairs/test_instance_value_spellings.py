"""Instance values spelled as people write them become the forms their fields declare, and nothing else.

Covers write-date-as-iso, restamp-declared-value-type, write-link-as-iri, empty-placeholder-value and
the label-only case of settle-instance-term-label. Every case also checks that an instance's own
provenance, its modification date above all, comes through untouched.
"""
import copy
import unittest

import cedar_artifact_repair as r

TEMPLATE_AT_TYPE = "https://schema.metadatacenter.org/core/Template"
TEMPLATE_ID = "https://repo.metadatacenter.org/templates/t"
PROVENANCE = ("pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy")


def field(input_type, required=("@value",), properties=("@type", "@value", "rdfs:label"), **constraints):
    return {"@type": r.FIELD_AT_TYPE, "type": "object", "_ui": {"inputType": input_type},
            "_valueConstraints": {"requiredValue": False, **constraints},
            "properties": {name: {} for name in properties}, "required": list(required)}


IRI_PROPERTIES = ("@id", "rdfs:label")


def template():
    sample = {"@type": r.ELEMENT_AT_TYPE, "type": "object",
              "properties": {"Taken": field("temporal", ("@value", "@type"), temporalType="xsd:date")}}
    return {"@id": TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
        "Visit": field("temporal", ("@value", "@type"), temporalType="xsd:date"),
        "Stamp": field("temporal", ("@value", "@type"), temporalType="xsd:dateTime"),
        "Count": field("numeric", ("@value", "@type"), numberType="xsd:int"),
        "Weight": field("numeric", ("@value", "@type")),
        "Page": field("link", (), IRI_PROPERTIES),
        "Note": field("textfield"),
        "Term": field("textfield", (), IRI_PROPERTIES, branches=[{"uri": "http://example.org/branch"}]),
        "Visits": {"type": "array", "items": field("temporal", ("@value", "@type"), temporalType="xsd:date")},
        "Sample": sample,
    }}


def instance(**values):
    document = {"@id": "https://repo.metadatacenter.org/template-instances/i", "schema:isBasedOn": TEMPLATE_ID,
                "pav:createdOn": "2019-01-02T03:04:05-08:00", "pav:createdBy": "https://metadatacenter.org/users/u",
                "pav:lastUpdatedOn": "2021-06-07T08:09:10-07:00", "oslc:modifiedBy": "https://metadatacenter.org/users/v"}
    document.update(values)
    return document


class WriteDateAsIsoTest(unittest.TestCase):
    def tearDown(self):
        r.DATE_ORDERS.clear()

    def test_spellings_that_settle_a_date_are_written_as_it(self):
        for stored, written in (("2019-4-3", "2019-04-03"), ("13/04/2019", "2019-04-13"), ("04/13/2019", "2019-04-13"),
                                ("13.04.2019", "2019-04-13"), ("13-04-2019", "2019-04-13"), ("3 April 2019", "2019-04-03"),
                                ("Apr. 3rd, 2019", "2019-04-03"), ("2019-04-03T00:00:00Z", "2019-04-03"),
                                ("2019-04-03 00:00", "2019-04-03")):
            with self.subTest(stored=stored):
                before = instance(Visit={"@value": stored, "@type": "xsd:date"})
                after, changes = r.write_date_as_iso(before, template())
                self.assertEqual(after["Visit"], {"@value": written, "@type": "xsd:date"})
                self.assertEqual(changes, [{"path": "/Visit/@value", "replaced": stored, "wrote": written}])
                self.assertIsNone(r.only_dates_written_as_iso(before, after, template()))
                self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_spellings_that_settle_nothing_are_left(self):
        for stored in ("03/04/2019", "2019", "2019-04", "2019-02-30", "2019-04-03T10:30:00", "unknown", "13/13/2019",
                       "Spring 2019", "2019-04-03"):
            with self.subTest(stored=stored):
                before = instance(Visit={"@value": stored, "@type": "xsd:date"})
                self.assertEqual(r.write_date_as_iso(before, template()), (before, []))

    def test_the_template_order_settles_an_ambiguous_date(self):
        before = instance(Visit={"@value": "03/04/2019", "@type": "xsd:date"})
        r.DATE_ORDERS[TEMPLATE_ID] = "day-first"
        self.assertEqual(r.write_date_as_iso(before, template())[0]["Visit"]["@value"], "2019-04-03")
        r.DATE_ORDERS[TEMPLATE_ID] = "month-first"
        after, _ = r.write_date_as_iso(before, template())
        self.assertEqual(after["Visit"]["@value"], "2019-03-04")
        self.assertIsNone(r.only_dates_written_as_iso(before, after, template()))
        r.DATE_ORDERS[TEMPLATE_ID] = "day-first"
        self.assertEqual(r.only_dates_written_as_iso(before, after, template()), "/Visit/@value")

    def test_only_date_fields_are_read_and_every_depth_is_reached(self):
        before = instance(Stamp={"@value": "13/04/2019", "@type": "xsd:dateTime"}, Note={"@value": "13/04/2019"},
                          Visits=[{"@value": "2019-04-03", "@type": "xsd:date"}, {"@value": "14/04/2019", "@type": "xsd:date"}],
                          Sample={"Taken": {"@value": "15/04/2019", "@type": "xsd:date"}})
        after, changes = r.write_date_as_iso(before, template())
        self.assertEqual(sorted(c["path"] for c in changes), ["/Sample/Taken/@value", "/Visits/1/@value"])
        self.assertEqual(after["Stamp"], before["Stamp"])
        self.assertEqual(after["Note"], before["Note"])
        self.assertIsNone(r.only_dates_written_as_iso(before, after, template()))

    def test_invariant_refuses_any_other_difference(self):
        before = instance(Visit={"@value": "13/04/2019", "@type": "xsd:date"})
        after, _ = r.write_date_as_iso(before, template())
        for pointer, mutate in (("/pav:lastUpdatedOn", lambda x: x.update(**{"pav:lastUpdatedOn": "2026-10-24T00:00:00Z"})),
                                ("/Visit/@value", lambda x: x["Visit"].update(**{"@value": "2019-13-04"})),
                                ("/Visit/@type", lambda x: x["Visit"].update(**{"@type": "xsd:dateTime"}))):
            with self.subTest(pointer=pointer):
                changed = copy.deepcopy(after)
                mutate(changed)
                self.assertEqual(r.only_dates_written_as_iso(before, changed, template()), pointer)


class RestampDeclaredValueTypeTest(unittest.TestCase):
    def test_a_wider_stated_type_narrows_where_the_value_already_fits(self):
        before = instance(Visit={"@value": "2019-04-03", "@type": "xsd:dateTime"}, Count={"@value": "12", "@type": "xsd:decimal"})
        after, changes = r.restamp_declared_value_type(before, template())
        self.assertEqual(after["Visit"]["@type"], "xsd:date")
        self.assertEqual(after["Count"]["@type"], "xsd:int")
        self.assertEqual(len(changes), 2)
        self.assertIsNone(r.only_restamped_value_types(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_value_the_declared_type_cannot_hold_keeps_its_type(self):
        before = instance(Visit={"@value": "2019-04-03T10:00:00", "@type": "xsd:dateTime"},
                          Count={"@value": "1.5", "@type": "xsd:decimal"}, Weight={"@value": "2", "@type": "xsd:int"})
        self.assertEqual(r.restamp_declared_value_type(before, template()), (before, []))

    def test_invariant_refuses_a_restamp_the_value_does_not_fit(self):
        before = instance(Count={"@value": "1.5", "@type": "xsd:decimal"})
        changed = copy.deepcopy(before)
        changed["Count"]["@type"] = "xsd:int"
        self.assertEqual(r.only_restamped_value_types(before, changed, template()), "/Count/@type")


class WriteLinkAsIriTest(unittest.TestCase):
    def test_bare_identifiers_and_addresses_become_the_iri_they_name(self):
        for stored, written in (("0000-0002-1825-0097", "https://orcid.org/0000-0002-1825-0097"),
                                (" www.example.org/a ", "https://www.example.org/a"),
                                ("10.1000/xyz123", "https://doi.org/10.1000/xyz123"),
                                ("someone@example.org", "mailto:someone@example.org")):
            with self.subTest(stored=stored):
                before = instance(Page={"@id": stored})
                after, changes = r.write_link_as_iri(before, template())
                self.assertEqual(after["Page"], {"@id": written})
                self.assertEqual(changes, [{"path": "/Page/@id", "replaced": stored, "wrote": written}])
                self.assertIsNone(r.only_links_written_as_iris(before, after, template()))
                self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_failed_check_digit_an_absolute_iri_and_other_text_are_left(self):
        for stored in ("0000-0002-1825-0098", "https://example.org/a", "see the paper", "example.org"):
            with self.subTest(stored=stored):
                before = instance(Page={"@id": stored})
                self.assertEqual(r.write_link_as_iri(before, template()), (before, []))

    def test_only_link_fields_are_read(self):
        before = instance(Term={"@id": "0000-0002-1825-0097", "rdfs:label": "x"})
        self.assertEqual(r.write_link_as_iri(before, template()), (before, []))


class EmptyPlaceholderValueTest(unittest.TestCase):
    def test_placeholders_become_the_empty_value_and_keep_their_datatype(self):
        before = instance(Visit={"@value": " N/A ", "@type": "xsd:date"}, Weight={"@value": "unknown", "@type": "xsd:decimal"},
                          Page={"@id": "NA"}, Sample={"Taken": {"@value": "none", "@type": "xsd:date"}})
        after, changes = r.empty_placeholder_value(before, template())
        self.assertEqual(after["Visit"], {"@value": None, "@type": "xsd:date"})
        self.assertEqual(after["Weight"], {"@value": None, "@type": "xsd:decimal"})
        self.assertEqual(after["Page"], {})
        self.assertEqual(after["Sample"]["Taken"], {"@value": None, "@type": "xsd:date"})
        self.assertEqual(len(changes), 4)
        self.assertIsNone(r.only_emptied_placeholders(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_none_in_a_number_and_text_that_is_not_a_placeholder_are_left(self):
        before = instance(Count={"@value": "none", "@type": "xsd:int"}, Weight={"@value": "about 3", "@type": "xsd:decimal"},
                          Note={"@value": "NA"})
        self.assertEqual(r.empty_placeholder_value(before, template()), (before, []))

    def test_invariant_refuses_emptying_a_value(self):
        before = instance(Weight={"@value": "3", "@type": "xsd:decimal"})
        changed = copy.deepcopy(before)
        changed["Weight"]["@value"] = None
        self.assertEqual(r.only_emptied_placeholders(before, changed, template()), "/Weight/@value")


class LabelOnlyTermTest(unittest.TestCase):
    def tearDown(self):
        r.TERMS.clear()

    def test_a_label_without_an_iri_is_put_behind_its_term(self):
        r.TERMS[TEMPLATE_ID] = {"/Term": {"a label": {"@id": "http://example.org/t", "rdfs:label": "A label"}}}
        before = instance(Term={"rdfs:label": "a label"})
        after, changes = r.settle_instance_term_label(before, template())
        self.assertEqual(after["Term"], {"@id": "http://example.org/t", "rdfs:label": "A label"})
        self.assertEqual(changes[0]["wrote"], "http://example.org/t")
        self.assertIsNone(r.only_settled_term_labels(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_label_mapped_to_nothing_empties_the_field(self):
        r.TERMS[TEMPLATE_ID] = {"/Term": {"a label": None}}
        before = instance(Term={"@id": "", "rdfs:label": "a label"})
        after, _ = r.settle_instance_term_label(before, template())
        self.assertEqual(after["Term"], {})
        self.assertIsNone(r.only_settled_term_labels(before, after, template()))

    def test_a_value_that_points_at_a_term_is_left(self):
        r.TERMS[TEMPLATE_ID] = {"/Term": {"a label": {"@id": "http://example.org/t", "rdfs:label": "A label"}}}
        before = instance(Term={"@id": "http://example.org/other", "rdfs:label": "a label"})
        self.assertEqual(r.settle_instance_term_label(before, template()), (before, []))


class StampDemandedTypeTest(unittest.TestCase):
    def test_a_named_datatype_is_stamped_on_a_value_even_where_the_schema_does_not_require_it(self):
        document = template()
        document["properties"]["Visit"]["required"] = ["@value"]
        before = instance(Visit={"@value": "2019-04-03"}, Weight={"@value": "2"},
                          Sample={"Taken": {"@value": None}})
        document["properties"]["Weight"]["required"] = ["@value"]
        after, changes = r.stamp_instance_value_type(before, document)
        self.assertEqual(after["Visit"], {"@value": "2019-04-03", "@type": "xsd:date"})
        # Weight names no numberType and its schema does not require one, so nothing demands a type.
        self.assertEqual(after["Weight"], {"@value": "2"})
        # Taken's schema requires @type, so even its empty value is stamped, as before.
        self.assertEqual(after["Sample"]["Taken"], {"@value": None, "@type": "xsd:date"})
        self.assertEqual(sorted(c["path"] for c in changes), ["/Sample/Taken/@type", "/Visit/@type"])
        self.assertIsNone(r.only_stamped_value_types(before, after, document))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})


class EmptyImportPlaceholdersTest(unittest.TestCase):
    PLACEHOLDER = "data_attributes_relatedIdentifiers_0_resourceTypeGeneral"

    def tearDown(self):
        r.PLACEHOLDER_TEMPLATES.clear()

    def test_every_placeholder_in_a_listed_template_becomes_its_field_empty_value(self):
        r.PLACEHOLDER_TEMPLATES.add(TEMPLATE_ID)
        before = instance(Note={"@value": "data_attributes_creators_0_nameType"}, Term={"rdfs:label": self.PLACEHOLDER},
                          Page={"@id": "data_attributes_url"}, Weight={"@value": "data_attributes_size", "@type": "xsd:decimal"},
                          Sample={"Taken": {"@value": "2019-04-03", "@type": "xsd:date"}})
        after, changes = r.empty_import_placeholders(before, template())
        self.assertEqual(after["Note"], {"@value": None})
        self.assertEqual(after["Term"], {})
        self.assertEqual(after["Page"], {})
        self.assertEqual(after["Weight"], {"@value": None, "@type": "xsd:decimal"})
        self.assertEqual(after["Sample"], before["Sample"])
        self.assertEqual(sorted(c["path"] for c in changes), ["/Note/@value", "/Page/@id", "/Term/rdfs:label", "/Weight/@value"])
        self.assertIsNone(r.only_emptied_import_placeholders(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        self.assertEqual(r.empty_import_placeholders(after, template()), (after, []))

    def test_an_unlisted_template_and_text_that_only_resembles_a_placeholder_are_left(self):
        before = instance(Note={"@value": "data_attributes_creators_0_nameType"})
        self.assertEqual(r.empty_import_placeholders(before, template()), (before, []))
        r.PLACEHOLDER_TEMPLATES.add(TEMPLATE_ID)
        resembling = instance(Note={"@value": "see data_attributes_x"}, Term={"@id": "http://example.org/t", "rdfs:label": "data_attributes"})
        self.assertEqual(r.empty_import_placeholders(resembling, template()), (resembling, []))

    def test_invariant_refuses_any_other_difference(self):
        r.PLACEHOLDER_TEMPLATES.add(TEMPLATE_ID)
        before = instance(Note={"@value": "data_attributes_x"}, Count={"@value": "3", "@type": "xsd:int"})
        after, _ = r.empty_import_placeholders(before, template())
        for pointer, mutate in (("/pav:lastUpdatedOn", lambda x: x.update(**{"pav:lastUpdatedOn": "2026-10-24T00:00:00Z"})),
                                ("/Count/@value", lambda x: x["Count"].update(**{"@value": None})),
                                ("/Note/@value", lambda x: x["Note"].pop("@value"))):
            with self.subTest(pointer=pointer):
                changed = copy.deepcopy(after)
                mutate(changed)
                self.assertEqual(r.only_emptied_import_placeholders(before, changed, template()), pointer)


def legacy_template():
    """A template shaped as 2017 wrote them: a choice typed as a list, a label every value must carry."""
    choice = field("radio", ("@value",))
    choice["properties"]["@value"] = {"type": ["array", "null"]}
    labelled = field("textfield", ("@value", "rdfs:label"))
    labelled["properties"]["rdfs:label"] = {"type": ["string", "null"]}
    inner = {"@type": r.ELEMENT_AT_TYPE, "type": "object", "properties": {"Kept": field("textfield")}}
    return {"@id": TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
        "Choice": choice, "Labelled": labelled, "Term": field("textfield", (), IRI_PROPERTIES, classes=[{"uri": "http://x/c"}]),
        "Block": inner, "@type": {"oneOf": [{"type": "string"}, {"type": "array"}]}}}


class LegacyShapeTest(unittest.TestCase):
    def test_a_required_nullable_label_is_stated_as_null(self):
        before = instance(Labelled={"@value": "x"}, Choice={"@value": None})
        after, changes = r.complete_required_label(before, legacy_template())
        self.assertEqual(after["Labelled"], {"@value": "x", "rdfs:label": None})
        self.assertNotIn("rdfs:label", after["Choice"])
        self.assertEqual(changes, [{"path": "/Labelled/rdfs:label", "replaced": None, "wrote": None}])
        self.assertIsNone(r.only_completed_required_labels(before, after, legacy_template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_null_iri_goes_and_the_class_beside_it_stays(self):
        before = instance(Term={"@id": None, "@type": "http://x/c"}, Labelled={"@value": None, "rdfs:label": None})
        after, changes = r.drop_null_iri(before, legacy_template())
        self.assertEqual(after["Term"], {"@type": "http://x/c"})
        self.assertEqual(after["Labelled"], before["Labelled"])
        self.assertIsNone(r.only_dropped_null_iris(before, after, legacy_template()))
        kept = instance(Term={"@id": "http://x/t", "@type": "http://x/c"})
        self.assertEqual(r.drop_null_iri(kept, legacy_template()), (kept, []))

    def test_a_literal_field_stops_demanding_a_label_and_still_declares_one(self):
        before = legacy_template()
        after, changes = r.drop_literal_label_demand(before)
        self.assertEqual(after["properties"]["Labelled"]["required"], ["@value"])
        self.assertIn("rdfs:label", after["properties"]["Labelled"]["properties"])
        self.assertEqual(after["properties"]["Term"], before["properties"]["Term"])
        self.assertEqual(changes, [{"path": "/properties/Labelled/required",
                                    "replaced": ["@value", "rdfs:label"], "wrote": ["@value"]}])
        self.assertIsNone(r.only_dropped_literal_label_demands(before, after))
        overreach = copy.deepcopy(after)
        overreach["properties"]["Labelled"]["required"] = []
        self.assertEqual(r.only_dropped_literal_label_demands(before, overreach), "/properties/Labelled/required")
        self.assertEqual(r.drop_literal_label_demand(after), (after, []))

    def test_an_iri_field_stops_demanding_a_label_and_one_demanding_only_its_iri_is_left(self):
        labelled = field("textfield", ("@id", "rdfs:label"), IRI_PROPERTIES)
        bare = field("textfield", ("rdfs:label",), IRI_PROPERTIES)
        identified = field("link", ("@id",), IRI_PROPERTIES)
        before = {"@id": TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
            "Labelled": labelled, "Bare": bare, "Identified": identified}}
        after, changes = r.drop_iri_label_demand(before)
        self.assertNotIn("required", after["properties"]["Labelled"])
        self.assertNotIn("required", after["properties"]["Bare"])
        self.assertEqual(after["properties"]["Identified"], identified)
        self.assertEqual(len(changes), 2)
        self.assertIsNone(r.only_dropped_iri_label_demands(before, after))
        overreach, _ = r.canonicalise_iri_field_required(before)
        self.assertEqual(r.only_dropped_iri_label_demands(before, overreach), "/properties/Identified/required")

    def test_a_field_declaring_both_shapes_stops_demanding_a_label_and_keeps_its_other_demands(self):
        mixed = field("textfield", ("@id", "rdfs:label"), ("@id", "@value", "rdfs:label"))
        alone = field("textfield", ("rdfs:label",), ("@id", "@value", "rdfs:label"))
        before = {"@id": TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
            "Mixed": mixed, "Alone": alone, "Labelled": legacy_template()["properties"]["Labelled"]}}
        after, changes = r.drop_mixed_field_label_demand(before)
        self.assertEqual(after["properties"]["Mixed"]["required"], ["@id"])
        self.assertNotIn("required", after["properties"]["Alone"])
        self.assertEqual(after["properties"]["Labelled"], before["properties"]["Labelled"])
        self.assertEqual(len(changes), 2)
        self.assertIsNone(r.only_dropped_mixed_field_label_demands(before, after))
        emptied = copy.deepcopy(after)
        emptied["properties"]["Alone"]["required"] = []
        self.assertEqual(r.only_dropped_mixed_field_label_demands(before, emptied), "/properties/Alone/required")

    def test_a_planned_child_repeats_and_nothing_else_changes(self):
        before = legacy_template()
        r.REPEATED_CHILDREN[TEMPLATE_ID] = {"Block": 1}
        try:
            after, changes = r.repeat_template_child(before)
            self.assertEqual(after["properties"]["Block"], {"type": "array", "minItems": 1, "items": before["properties"]["Block"]})
            self.assertEqual({k: v for k, v in after["properties"].items() if k != "Block"},
                             {k: v for k, v in before["properties"].items() if k != "Block"})
            self.assertEqual([change["path"] for change in changes], ["/properties/Block"])
            self.assertIsNone(r.only_repeated_template_children(before, after))
            loose = copy.deepcopy(after); loose["properties"]["Block"]["minItems"] = 0
            self.assertEqual(r.only_repeated_template_children(before, loose), "/properties/Block/minItems")
            with self.assertRaises(r.TransformRefused):
                r.repeat_template_child(after)
        finally:
            r.REPEATED_CHILDREN.clear()
        self.assertEqual(r.repeat_template_child(before), (before, []))

    def test_a_null_label_leaves_a_literal_once_its_field_stops_demanding_one(self):
        loosened, _ = r.drop_literal_label_demand(legacy_template())
        before = instance(Labelled={"@value": None, "rdfs:label": None})
        after, changes = r.drop_null_literal_label(before, loosened)
        self.assertEqual(after["Labelled"], {"@value": None})
        self.assertEqual(changes, [{"path": "/Labelled/rdfs:label", "replaced": None, "wrote": None}])
        self.assertIsNone(r.only_dropped_null_literal_labels(before, after, loosened))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        # Still demanded, or holding text: left as it stands.
        self.assertEqual(r.drop_null_literal_label(before, legacy_template()), (before, []))
        written = instance(Labelled={"@value": "x", "rdfs:label": "a label"})
        self.assertEqual(r.drop_null_literal_label(written, loosened), (written, []))

    def test_a_null_root_type_is_removed_and_a_stated_one_is_kept(self):
        before = instance(**{"@type": None})
        after, changes = r.drop_null_instance_type(before)
        self.assertNotIn("@type", after)
        self.assertIsNone(r.only_dropped_null_instance_type(before, after))
        typed = instance(**{"@type": "http://x/class"})
        self.assertEqual(r.drop_null_instance_type(typed), (typed, []))

    def test_unfilled_undeclared_keys_go_at_every_depth_and_entered_ones_stay(self):
        minted = "https://repo.metadatacenter.org/template-element-instances/0b5c2a54-8b7e-4c55-9f3e-3c2a1e0f9d11"
        before = instance(**{
            "@context": {"Old": "http://x/old", "Choice": "http://x/choice"},
            "Old": {"@value": None},
            "Kept old": {"@value": "someone typed this"},
            "Block": {"@id": minted, "@context": {"Gone": "http://x/gone", "Kept": "http://x/kept"},
                      "Kept": {"@value": "k"},
                      "Gone": [{"@id": minted, "@context": {}, "Inner": {"@value": None, "@type": "xsd:string"}}]},
        })
        after, changes = r.drop_unfilled_undeclared_keys(before, legacy_template())
        self.assertNotIn("Old", after)
        self.assertNotIn("Old", after["@context"])
        self.assertEqual(after["Kept old"], before["Kept old"])
        self.assertNotIn("Gone", after["Block"])
        self.assertEqual(after["Block"]["@context"], {"Kept": "http://x/kept"})
        self.assertEqual(after["Block"]["Kept"], {"@value": "k"})
        self.assertIsNone(r.only_dropped_unfilled_undeclared_keys(before, after, legacy_template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        changed = copy.deepcopy(after); del changed["Kept old"]
        self.assertEqual(r.only_dropped_unfilled_undeclared_keys(before, changed, legacy_template()), "/Kept old")
        changed = copy.deepcopy(after); del changed["@context"]["Choice"]
        self.assertEqual(r.only_dropped_unfilled_undeclared_keys(before, changed, legacy_template()), "/@context/Choice")


class DropUndeclaredKeysTest(unittest.TestCase):
    def test_every_undeclared_key_goes_with_its_mapping_and_declared_ones_stay(self):
        before = instance(**{"@context": {"Old": "http://x/old", "Labelled": "http://x/l"},
                             "Old": {"@value": "someone typed this"}, "Labelled": {"@value": "x", "rdfs:label": None},
                             "Block": {"Kept": {"@value": "k"}, "Renamed": {"@value": "v"}}})
        after, changes = r.drop_undeclared_keys(before, legacy_template())
        self.assertNotIn("Old", after)
        self.assertEqual(after["@context"], {"Labelled": "http://x/l"})
        self.assertEqual(after["Block"], {"Kept": {"@value": "k"}})
        self.assertEqual(after["Labelled"], before["Labelled"])
        self.assertIsNone(r.only_dropped_undeclared_keys(before, after, legacy_template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        # The unfilled-only rule leaves the entered values alone.
        kept, _ = r.drop_unfilled_undeclared_keys(before, legacy_template())
        self.assertEqual(kept["Old"], before["Old"])
        changed = copy.deepcopy(after); del changed["Labelled"]
        self.assertEqual(r.only_dropped_undeclared_keys(before, changed, legacy_template()), "/Labelled")

    def test_applying_it_needs_an_explicit_approval(self):
        import contextlib
        import io
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl") as records:
            records.write('{"artifactType": "instance", "artifactId": "urn:i", "conditionRules": {"c": 1}}\n')
            records.flush()
            message = io.StringIO()
            with contextlib.redirect_stderr(message), self.assertRaises(SystemExit):
                r.main(["--from-records", records.name, "--condition", "c", "--repair", "drop-undeclared-keys",
                        "--apply", "--api-key-file", records.name])
        self.assertIn("deletes entered values", message.getvalue())


class TypeChoiceValueAsTextTest(unittest.TestCase):
    def test_a_legacy_choice_field_types_its_value_as_text_at_every_depth(self):
        legacy = legacy_template()
        legacy["properties"]["Block"]["properties"]["Pick"] = field("list", ("@value",))
        legacy["properties"]["Block"]["properties"]["Pick"]["properties"]["@value"] = {"type": ["array", "null"]}
        legacy["properties"]["Choice"]["properties"]["@value"] = {"type": ["array", "null"]}
        after, changes = r.type_choice_value_as_text(legacy)
        self.assertEqual(after["properties"]["Choice"]["properties"]["@value"], {"type": ["string", "null"]})
        self.assertEqual(after["properties"]["Block"]["properties"]["Pick"]["properties"]["@value"], {"type": ["string", "null"]})
        self.assertEqual(len(changes), 2)
        self.assertIsNone(r.only_typed_choice_values_as_text(legacy, after))
        self.assertEqual(r.type_choice_value_as_text(after), (after, []))
        changed = copy.deepcopy(after); changed["properties"]["Labelled"]["properties"]["@value"] = {"type": ["integer"]}
        self.assertIsNotNone(r.only_typed_choice_values_as_text(legacy, changed))

    def test_a_text_field_typed_as_a_list_is_not_a_choice_and_is_left(self):
        legacy = legacy_template()
        legacy["properties"]["Labelled"]["properties"]["@value"] = {"type": ["array", "null"]}
        self.assertEqual(r.type_choice_value_as_text(legacy)[1], [{"path": "/properties/Choice/properties/@value/type",
                                                                    "replaced": ["array", "null"], "wrote": ["string", "null"]}])


class RestateModifierTest(unittest.TestCase):
    LEGACY = "https://repo.metadatacenter.net/users/184ce0be-2fe8-400c-925c-788d56ff1202"
    CURRENT = "https://metadatacenter.org/users/184ce0be-2fe8-400c-925c-788d56ff1202"

    def tearDown(self):
        r.MODIFIER_FORMS.clear()

    def test_a_listed_legacy_modifier_becomes_the_form_the_graph_holds(self):
        before = instance(**{"oslc:modifiedBy": self.LEGACY})
        r.MODIFIER_FORMS[before["@id"]] = self.CURRENT
        after, changes = r.restate_modifier_in_current_form(before)
        self.assertEqual(after["oslc:modifiedBy"], self.CURRENT)
        self.assertEqual(changes, [{"path": "/oslc:modifiedBy", "replaced": self.LEGACY, "wrote": self.CURRENT}])
        self.assertEqual({k: after[k] for k in PROVENANCE if k != "oslc:modifiedBy"},
                         {k: before[k] for k in PROVENANCE if k != "oslc:modifiedBy"})
        self.assertIsNone(r.only_restated_modifier(before, after))

    def test_an_unlisted_artifact_or_another_user_is_left(self):
        before = instance(**{"oslc:modifiedBy": self.LEGACY})
        self.assertEqual(r.restate_modifier_in_current_form(before), (before, []))
        r.MODIFIER_FORMS[before["@id"]] = "https://metadatacenter.org/users/someone-else"
        self.assertEqual(r.restate_modifier_in_current_form(before), (before, []))

    def test_invariant_refuses_any_other_change(self):
        before = instance(**{"oslc:modifiedBy": self.LEGACY})
        r.MODIFIER_FORMS[before["@id"]] = self.CURRENT
        after, _ = r.restate_modifier_in_current_form(before)
        changed = dict(after, **{"pav:createdBy": self.CURRENT})
        self.assertEqual(r.only_restated_modifier(before, changed), "/pav:createdBy")


class RestateUserIrisTest(unittest.TestCase):
    LEGACY = "https://repo.metadatacenter.net/users/u1"
    CURRENT = "https://metadatacenter.org/users/u1"

    def test_creators_and_modifiers_at_every_depth_take_the_current_form(self):
        before = {"@id": "urn:t", "pav:createdBy": self.LEGACY, "oslc:modifiedBy": "https://metadatacenter.org/users/u2",
                  "pav:lastUpdatedOn": "2017-01-01T00:00:00Z",
                  "properties": {"Block": {"pav:createdBy": self.LEGACY, "oslc:modifiedBy": self.LEGACY,
                                           "items": [{"pav:createdBy": self.LEGACY}]},
                                 "Note": {"description": self.LEGACY}}}
        after, changes = r.restate_user_iris_in_current_form(before)
        self.assertEqual(after["pav:createdBy"], self.CURRENT)
        self.assertEqual(after["oslc:modifiedBy"], "https://metadatacenter.org/users/u2")
        self.assertEqual(after["properties"]["Block"]["oslc:modifiedBy"], self.CURRENT)
        self.assertEqual(after["properties"]["Block"]["items"][0]["pav:createdBy"], self.CURRENT)
        self.assertEqual(after["properties"]["Note"], before["properties"]["Note"])
        self.assertEqual(after["pav:lastUpdatedOn"], before["pav:lastUpdatedOn"])
        self.assertEqual(len(changes), 4)
        self.assertIsNone(r.only_restated_user_iris(before, after))
        self.assertEqual(r.restate_user_iris_in_current_form(after), (after, []))

    def test_invariant_refuses_another_user_or_another_key(self):
        before = {"pav:createdBy": self.LEGACY, "rdfs:label": self.LEGACY}
        self.assertEqual(r.only_restated_user_iris(before, dict(before, **{"pav:createdBy": "https://metadatacenter.org/users/u9"})), "/pav:createdBy")
        self.assertEqual(r.only_restated_user_iris(before, dict(before, **{"rdfs:label": self.CURRENT})), "/rdfs:label")


class AllowTermNotationTest(unittest.TestCase):
    def test_a_term_field_without_a_notation_gains_one_and_nothing_else_changes(self):
        document = template()
        document["properties"]["Visits"]["items"]["properties"]["@value"] = {"type": ["string", "null"]}
        after, changes = r.allow_term_notation(document)
        self.assertEqual(after["properties"]["Term"]["properties"]["skos:notation"], {"type": ["string", "null"]})
        self.assertNotIn("skos:notation", after["properties"]["Page"]["properties"])
        self.assertEqual(changes, [{"path": "/properties/Term/properties/skos:notation", "replaced": None,
                                    "wrote": {"type": ["string", "null"]}}])
        self.assertIsNone(r.only_allowed_term_notations(document, after))
        self.assertEqual(r.allow_term_notation(after), (after, []))
        changed = copy.deepcopy(after); changed["properties"]["Page"]["properties"]["skos:notation"] = {"type": ["string", "null"]}
        self.assertEqual(r.only_allowed_term_notations(document, changed), "/properties/Page/properties/skos:notation")

    def test_every_iri_field_without_a_notation_gains_one_and_a_literal_does_not(self):
        document = template()
        after, changes = r.allow_iri_notation(document)
        for name in ("Term", "Page"):
            self.assertEqual(after["properties"][name]["properties"]["skos:notation"], {"type": ["string", "null"]})
        self.assertNotIn("skos:notation", after["properties"]["Note"]["properties"])
        self.assertEqual(sorted(change["path"] for change in changes),
                         ["/properties/Page/properties/skos:notation", "/properties/Term/properties/skos:notation"])
        self.assertIsNone(r.only_allowed_iri_notations(document, after))
        self.assertEqual(r.allow_iri_notation(after), (after, []))
        changed = copy.deepcopy(after); changed["properties"]["Note"]["properties"]["skos:notation"] = {"type": ["string", "null"]}
        self.assertEqual(r.only_allowed_iri_notations(document, changed), "/properties/Note/properties/skos:notation")


class ContextOpennessTest(unittest.TestCase):
    def document(self, sample_context, with_attribute_value=False):
        document = template()
        document["properties"]["@context"] = {"type": "object", "properties": {}, "additionalProperties": False}
        sample = document["properties"]["Sample"]
        sample["properties"]["@context"] = {"type": "object", "properties": {}, "additionalProperties": sample_context}
        if with_attribute_value:
            sample["properties"]["Extra"] = {"type": "array", "items": field("attribute-value", (), ("@value", "@type"))}
        return document

    def test_an_element_without_an_attribute_value_child_closes_its_context(self):
        before = self.document(copy.deepcopy(r.OPEN_CONTEXT))
        after, changes = r.settle_context_openness(before)
        self.assertIs(after["properties"]["Sample"]["properties"]["@context"]["additionalProperties"], False)
        self.assertIs(after["properties"]["@context"]["additionalProperties"], False)
        self.assertEqual([c["path"] for c in changes], ["/properties/Sample/properties/@context/additionalProperties"])
        self.assertIsNone(r.only_settled_context_openness(before, after))

    def test_an_element_with_an_attribute_value_child_opens_its_context(self):
        before = self.document(False, with_attribute_value=True)
        after, changes = r.settle_context_openness(before)
        self.assertEqual(after["properties"]["Sample"]["properties"]["@context"]["additionalProperties"], r.OPEN_CONTEXT)
        self.assertEqual(len(changes), 1)
        self.assertIsNone(r.only_settled_context_openness(before, after))

    def test_a_settled_or_unrecognised_context_is_left_and_tampering_is_caught(self):
        for settled in (self.document(False), self.document(copy.deepcopy(r.OPEN_CONTEXT), with_attribute_value=True),
                        self.document({"type": "string"})):
            self.assertEqual(r.settle_context_openness(settled)[1], [])
        before = self.document(copy.deepcopy(r.OPEN_CONTEXT))
        tampered, _changes = r.settle_context_openness(before)
        tampered["properties"]["@context"]["additionalProperties"] = copy.deepcopy(r.OPEN_CONTEXT)
        self.assertEqual(r.only_settled_context_openness(before, tampered), "/properties/@context/additionalProperties")


class ShadowedContextAndCreatorTest(unittest.TestCase):
    def tearDown(self):
        r.CREATORS.clear()

    def shadowing_template(self):
        inner = {"@type": r.ELEMENT_AT_TYPE, "type": "object",
                 "properties": {"@context": {"properties": {"untitled": {}}}, "untitled": field("textfield")}}
        return {"@id": TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE,
                "properties": {"@context": {"properties": {"License": {}}}, "License": inner}}

    def test_a_term_only_its_own_mapping_uses_inside_an_element_goes(self):
        before = instance(**{"@context": {"License": "http://x/license", "untitled": "http://x/outer"},
                             "License": {"@context": {"untitled": "http://x/inner"}, "untitled": {"@value": None}}})
        after, changes = r.drop_shadowed_instance_context(before, self.shadowing_template())
        self.assertEqual(after["@context"], {"License": "http://x/license"})
        self.assertEqual(after["License"], before["License"])
        self.assertEqual(changes[0]["path"], "/@context/untitled")
        self.assertIsNone(r.only_dropped_shadowed_context(before, after, self.shadowing_template()))

    def test_a_term_used_outside_any_shadowing_element_stays(self):
        before = instance(**{"@context": {"License": "http://x/license", "untitled": "http://x/outer"},
                             "License": {"@context": {}, "untitled": {"@value": None}}})
        self.assertEqual(r.drop_shadowed_instance_context(before, self.shadowing_template()), (before, []))

    def test_the_graph_creator_is_stated_only_where_none_is(self):
        creator = "https://metadatacenter.org/users/u1"
        before = {k: v for k, v in instance().items() if k != "pav:createdBy"}
        r.CREATORS[before["@id"]] = creator
        after, changes = r.state_creator_from_graph(before)
        self.assertEqual(after["pav:createdBy"], creator)
        self.assertIsNone(r.only_stated_graph_creator(before, after))
        stated = instance()
        r.CREATORS[stated["@id"]] = creator
        self.assertEqual(r.state_creator_from_graph(stated), (stated, []))
        self.assertEqual(r.only_stated_graph_creator(before, dict(after, **{"pav:createdBy": "https://metadatacenter.org/users/other"})), "/pav:createdBy")


class TermFieldDeletionsTest(unittest.TestCase):
    def classed_template(self, required=()):
        document = template()
        term = field("textfield", required, ("@id", "@type", "rdfs:label"), branches=[{"uri": "http://example.org/branch"}])
        term["properties"]["@type"] = {"oneOf": [{"type": "string", "enum": ["http://c/Animals"]},
                                                 {"type": "array", "items": {"enum": ["http://c/Animals"]}}]}
        document["properties"]["Classed"] = term
        return document

    def test_typed_text_in_a_term_field_is_emptied_and_nothing_else(self):
        before = instance(Term={"@value": "typed by hand"}, Note={"@value": "kept"})
        after, changes = r.drop_term_field_text(before, template())
        self.assertEqual(after["Term"], {})
        self.assertEqual(after["Note"], {"@value": "kept"})
        self.assertEqual(changes, [{"path": "/Term", "replaced": {"@value": "typed by hand"}, "wrote": {}}])
        self.assertIsNone(r.only_dropped_term_field_text(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_term_value_with_anything_beside_its_text_is_left(self):
        for value in ({"@value": "text", "@id": "http://t/1"}, {"@value": "text", "rdfs:label": "text"}, {"@value": ""},
                      {"@id": "http://t/1", "rdfs:label": "One"}):
            with self.subTest(value=value):
                before = instance(Term=value)
                self.assertEqual(r.drop_term_field_text(before, template()), (before, []))
        before = instance(Term={"@value": "typed"}, Note={"@value": "kept"})
        tampered = dict(before, Term={}, Note={})
        self.assertEqual(r.only_dropped_term_field_text(before, tampered, template()), "/Note/@value")

    def test_a_class_the_schema_does_not_list_is_dropped_and_the_term_kept(self):
        before = instance(Classed={"@id": "http://t/alligator", "@type": "http://c/Reptiles", "rdfs:label": "Alligator"})
        after, changes = r.drop_unlisted_term_class(before, self.classed_template())
        self.assertEqual(after["Classed"], {"@id": "http://t/alligator", "rdfs:label": "Alligator"})
        self.assertEqual(changes, [{"path": "/Classed/@type", "replaced": "http://c/Reptiles", "wrote": None}])
        self.assertIsNone(r.only_dropped_unlisted_term_classes(before, after, self.classed_template()))

    def test_a_listed_class_or_a_required_type_is_left(self):
        listed = instance(Classed={"@id": "http://t/dog", "@type": ["http://c/Animals"]})
        self.assertEqual(r.drop_unlisted_term_class(listed, self.classed_template()), (listed, []))
        unlisted = instance(Classed={"@id": "http://t/alligator", "@type": "http://c/Reptiles"})
        self.assertEqual(r.drop_unlisted_term_class(unlisted, self.classed_template(required=("@type",))), (unlisted, []))
        self.assertEqual(r.drop_unlisted_term_class(instance(Term={"@id": "http://t/1", "@type": "http://c/X"}), template())[1], [])

    def test_a_stamped_list_of_classes_is_dropped_from_term_and_text_values(self):
        stamped = ["http://purl.bioontology.org/ontology/LNC/LA17713-1", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl#C3671"]
        before = instance(Term={"@id": "http://t/burn", "@type": stamped, "rdfs:label": "Burn"},
                          Note={"@value": "Ada", "@type": stamped})
        after, changes = r.drop_stamped_class_list(before, template())
        self.assertEqual(after["Term"], {"@id": "http://t/burn", "rdfs:label": "Burn"})
        self.assertEqual(after["Note"], {"@value": "Ada"})
        self.assertEqual(sorted(c["path"] for c in changes), ["/Note/@type", "/Term/@type"])
        self.assertIsNone(r.only_dropped_stamped_class_lists(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})

    def test_a_single_type_or_a_list_naming_a_datatype_is_left(self):
        for stated in ("http://c/Animals", ["http://c/Animals"], ["xsd:string", "http://c/Animals"],
                       ["http://www.w3.org/2001/XMLSchema#date", "http://c/Day"], ["http://c/A", "not an iri"]):
            with self.subTest(stated=stated):
                before = instance(Term={"@id": "http://t/1", "@type": stated})
                self.assertEqual(r.drop_stamped_class_list(before, template()), (before, []))
        before = instance(Term={"@id": "http://t/1", "@type": ["http://c/A", "http://c/B"]})
        self.assertEqual(r.only_dropped_stamped_class_lists(before, dict(before, Term={}), template()), "/Term/@id")

    def test_both_deletions_need_the_value_deletion_approval_and_a_scope(self):
        for name in ("drop-term-field-text", "drop-unlisted-term-class", "drop-stamped-class-list"):
            with self.subTest(name=name):
                self.assertIn(name, r.VALUE_DELETING_REPAIRS)
                with self.assertRaises(SystemExit):
                    r.main(["--apply", "--repair", name, "--from-records", "unused.jsonl"])


class OwnerChoicesTest(unittest.TestCase):
    def test_a_bare_date_in_a_datetime_field_becomes_that_days_midnight_utc(self):
        before = instance(Stamp={"@value": "2024-06-22", "@type": "xsd:date"}, Visit={"@value": "2024-06-22", "@type": "xsd:date"})
        after, changes = r.write_date_at_midnight(before, template())
        self.assertEqual(after["Stamp"], {"@value": "2024-06-22T00:00:00Z", "@type": "xsd:dateTime"})
        self.assertEqual(after["Visit"], before["Visit"])
        self.assertEqual([c["path"] for c in changes], ["/Stamp"])
        self.assertIsNone(r.only_wrote_dates_at_midnight(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        tampered = dict(after, Stamp={"@value": "2024-06-22T09:00:00Z", "@type": "xsd:dateTime"})
        self.assertEqual(r.only_wrote_dates_at_midnight(before, tampered, template()), "/Stamp/@value")

    def test_only_a_real_calendar_date_without_a_time_is_given_midnight(self):
        for value in ({"@value": "2024-02-30", "@type": "xsd:date"}, {"@value": "2024-06-22T10:00:00Z", "@type": "xsd:dateTime"},
                      {"@value": "22/06/2024"}, {"@value": None, "@type": "xsd:dateTime"}, {"@value": "2024-06-22", "@type": "xsd:time"}):
            with self.subTest(value=value):
                before = instance(Stamp=value)
                self.assertEqual(r.write_date_at_midnight(before, template()), (before, []))

    def test_a_text_beside_a_chosen_term_goes_and_the_term_stays(self):
        before = instance(Term={"@id": "http://t/1", "rdfs:label": "One", "@value": "Something else"})
        after, changes = r.drop_text_beside_term(before, template())
        self.assertEqual(after["Term"], {"@id": "http://t/1", "rdfs:label": "One"})
        self.assertEqual(changes, [{"path": "/Term/@value", "replaced": "Something else", "wrote": None}])
        self.assertIsNone(r.only_dropped_text_beside_terms(before, after, template()))
        for value in ({"@id": "http://t/1", "rdfs:label": "One", "@value": "One"}, {"@id": "http://t/1", "@value": ""},
                      {"@value": "text only"}, {"@id": "not an iri", "@value": "text"}):
            with self.subTest(value=value):
                kept = instance(Term=value)
                self.assertEqual(r.drop_text_beside_term(kept, template()), (kept, []))

    def test_spaces_inside_a_link_are_encoded_and_nothing_else_changes(self):
        before = instance(Page={"@id": "https://example.org/species/Lynx lynx page "})
        after, changes = r.encode_link_spaces(before, template())
        self.assertEqual(after["Page"], {"@id": "https://example.org/species/Lynx%20lynx%20page"})
        self.assertEqual(changes[0]["path"], "/Page/@id")
        self.assertIsNone(r.only_encoded_link_spaces(before, after, template()))
        for name, value in (("Page", {"@id": "https://example.org/fine"}), ("Page", {"@id": "no scheme here"}),
                            ("Term", {"@id": "https://example.org/a b"})):
            with self.subTest(name=name, value=value):
                kept = instance(**{name: value})
                self.assertEqual(r.encode_link_spaces(kept, template()), (kept, []))

    def test_assuming_a_time_and_dropping_a_text_each_need_their_approval(self):
        with self.assertRaises(SystemExit):
            r.main(["--apply", "--repair", "write-date-at-midnight", "--from-records", "unused.jsonl", "--only-ids", "ids.json"])
        self.assertIn("drop-text-beside-term", r.VALUE_DELETING_REPAIRS)
        self.assertNotIn("encode-link-spaces", r.VALUE_DELETING_REPAIRS)


class CutLinkAtQuotationMarkTest(unittest.TestCase):
    def test_a_url_pasted_with_the_rest_of_a_sentence_keeps_only_the_url(self):
        before = instance(Page={"@id": 'https://example.org/reports/200", which is specific to this'},
                          Term={"@id": 'https://example.org/term", said someone'})
        after, changes = r.cut_link_at_quotation_mark(before, template())
        self.assertEqual(after["Page"], {"@id": "https://example.org/reports/200"})
        self.assertEqual(after["Term"], before["Term"])
        self.assertEqual(changes, [{"path": "/Page/@id", "replaced": before["Page"]["@id"],
                                    "wrote": "https://example.org/reports/200"}])
        self.assertIsNone(r.only_cut_links(before, after, template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        self.assertEqual(r.cut_link_at_quotation_mark(after, template())[1], [])
        trimmed = copy.deepcopy(after); trimmed["Page"]["@id"] = "https://example.org/reports"
        self.assertEqual(r.only_cut_links(before, trimmed, template()), "/Page/@id")
        self.assertIn("cut-link-at-quotation-mark", r.VALUE_DELETING_REPAIRS)

    def test_nothing_is_cut_where_the_text_before_the_mark_is_not_an_address(self):
        for address in ['see "https://example.org/"', '"https://example.org/"', "https://example.org/a b"]:
            before = instance(Page={"@id": address})
            self.assertEqual(r.cut_link_at_quotation_mark(before, template()), (before, []))


def links_template():
    links = template()
    links["properties"]["Links"] = {"type": "array", "minItems": 0, "items": field("link", (), ("@id",))}
    return links


class JoinedLinksTest(unittest.TestCase):
    JOINED = "https://example.org/a; https://example.org/b"

    def tearDown(self):
        r.JOINED_LINK_CHOICES.clear()

    def test_a_repeating_link_entry_joining_addresses_becomes_one_entry_each(self):
        before = instance(Links=[{"@id": "https://example.org/first"}, {"@id": self.JOINED}], Page={"@id": self.JOINED})
        after, changes = r.split_joined_links(before, links_template())
        self.assertEqual(after["Links"], [{"@id": "https://example.org/first"}, {"@id": "https://example.org/a"},
                                          {"@id": "https://example.org/b"}])
        self.assertEqual(after["Page"], before["Page"])
        self.assertEqual(changes, [{"path": "/Links/1", "replaced": self.JOINED,
                                    "wrote": ["https://example.org/a", "https://example.org/b"]}])
        self.assertIsNone(r.only_split_joined_links(before, after, links_template()))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})
        reordered = copy.deepcopy(after); reordered["Links"][1:] = reordered["Links"][:0:-1]
        self.assertEqual(r.only_split_joined_links(before, reordered, links_template()), "/Links/1/@id")
        for entry in [{"@id": "see https://example.org/a; https://example.org/b"},
                      {"@id": self.JOINED, "rdfs:label": "two links"}]:
            unsplit = instance(Links=[entry])
            self.assertEqual(r.split_joined_links(unsplit, links_template()), (unsplit, []))

    def test_a_single_link_field_keeps_only_the_reviewed_address(self):
        before = instance(Page={"@id": self.JOINED})
        r.JOINED_LINK_CHOICES[before["@id"]] = {"/Page": "https://example.org/a"}
        after, changes = r.choose_reviewed_joined_link(before, links_template())
        self.assertEqual(after["Page"], {"@id": "https://example.org/a"})
        self.assertEqual(changes, [{"path": "/Page/@id", "replaced": self.JOINED, "wrote": "https://example.org/a"}])
        self.assertIsNone(r.only_chosen_joined_links(before, after, links_template()))
        other = copy.deepcopy(after); other["Page"]["@id"] = "https://example.org/b"
        self.assertEqual(r.only_chosen_joined_links(before, other, links_template()), "/Page/@id")
        r.JOINED_LINK_CHOICES[before["@id"]] = {"/Page": "https://example.org/c"}
        with self.assertRaises(r.TransformRefused):
            r.choose_reviewed_joined_link(before, links_template())
        r.JOINED_LINK_CHOICES.clear()
        self.assertEqual(r.choose_reviewed_joined_link(before, links_template()), (before, []))
        self.assertIn("choose-reviewed-joined-link", r.VALUE_DELETING_REPAIRS)
        self.assertNotIn("split-joined-links", r.VALUE_DELETING_REPAIRS)


def container(children, iris):
    return {"@type": r.ELEMENT_AT_TYPE, "type": "object", "properties": {
        "@context": {"properties": {name: {"enum": [iri]} for name, iri in iris.items()}}, **children}}


def rebuilt_template():
    """A template rebuilt in place: new property IRIs, a new nesting, a list where a single field was."""
    subject = container({"Count": field("numeric", ("@value", "@type"), numberType="xsd:int")}, {"Count": "http://x/p/count"})
    dataset = container({"Status": {"type": "array", "minItems": 1, "items": field("checkbox")}, "Subject": subject},
                        {"Status": "http://x/p/status", "Subject": "http://x/p/subject"})
    rebuilt = container({"Dataset": dataset, "Note": field("textfield"), "Remark": field("textfield")},
                        {"Dataset": "http://x/p/dataset", "Note": "http://x/p/note", "Remark": "http://x/p/remark"})
    return {"@id": TEMPLATE_ID, **rebuilt, "@type": TEMPLATE_AT_TYPE}


OLD_DATA = "https://repo.metadatacenter.org/template-element-instances/11111111-1111-4111-8111-111111111111"
OLD_PERSON = "https://repo.metadatacenter.org/template-element-instances/22222222-2222-4222-8222-222222222222"


def old_structure_instance():
    return instance(**{
        "@context": {"schema": "http://schema.org/", "Data": "http://x/old/data", "Person": "http://x/old/person",
                     "Note": "http://x/old/note"},
        "Data": [{"@id": OLD_DATA, "@context": {"Derivation": "http://x/old/derivation", "Size": "http://x/old/size"},
                  "Derivation": {"@value": "Raw"}, "Size": {"@value": "33", "@type": "xsd:decimal"}}],
        "Person": {"@id": OLD_PERSON, "@context": {"Name": "http://x/old/name"}, "Name": {"@value": "someone"}},
        "Note": {"@value": "kept"},
    })


def mapping_plan():
    return {"template": TEMPLATE_ID,
            "elements": [{"from": "/Data/0", "to": "/Dataset"}],
            "moves": [{"from": "/Data/0/Derivation", "to": "/Dataset/Status"},
                      {"from": "/Data/0/Size", "to": "/Dataset/Subject/Count", "write": {"@value": "33", "@type": "xsd:int"}},
                      {"from": "/Note", "to": "/Note"}],
            "drop": ["/Person/Name"]}


class ReviewedInstanceMappingTest(unittest.TestCase):
    def setUp(self):
        r.INSTANCE_MAPPING_PLANS[instance()["@id"]] = mapping_plan()

    def tearDown(self):
        r.INSTANCE_MAPPING_PLANS.clear()

    def test_values_move_as_planned_and_a_continued_occurrence_keeps_its_identifier(self):
        before = old_structure_instance()
        after, changes = r.apply_reviewed_instance_mapping(before, rebuilt_template())
        self.assertEqual(after["Dataset"]["@id"], OLD_DATA)
        self.assertEqual(after["Dataset"]["Status"], [{"@value": "Raw"}])
        self.assertEqual(after["Dataset"]["Subject"]["Count"], {"@value": "33", "@type": "xsd:int"})
        self.assertTrue(r.is_fresh_element_id(after["Dataset"]["Subject"]["@id"]))
        self.assertEqual(after["Note"], {"@value": "kept"})
        self.assertNotIn("Data", after)
        self.assertNotIn("Person", after)
        self.assertEqual(after["Remark"], {"@value": None})
        self.assertEqual(after["@context"], {"schema": "http://schema.org/", "Dataset": "http://x/p/dataset",
                                             "Note": "http://x/p/note", "Remark": "http://x/p/remark"})
        self.assertEqual({k: after[k] for k in PROVENANCE + ("@id", "schema:isBasedOn")},
                         {k: before[k] for k in PROVENANCE + ("@id", "schema:isBasedOn")})
        self.assertEqual(sorted(change["path"] for change in changes),
                         ["/Dataset/@id", "/Dataset/Status", "/Dataset/Subject/Count", "/Note", "/Person/Name"])
        self.assertIsNone(r.only_reviewed_instance_mapping(before, after, rebuilt_template()))

    def test_the_invariant_refuses_anything_the_plan_did_not_place(self):
        before = old_structure_instance()
        after, _changes = r.apply_reviewed_instance_mapping(before, rebuilt_template())
        smuggled = copy.deepcopy(after); smuggled["Dataset"]["Status"].append({"@value": "someone"})
        self.assertEqual(r.only_reviewed_instance_mapping(before, smuggled, rebuilt_template()), "/Dataset/Status")
        stray = copy.deepcopy(after); stray["Remark"] = {"@value": "someone"}
        self.assertEqual(r.only_reviewed_instance_mapping(before, stray, rebuilt_template()), "/Remark")
        reused = copy.deepcopy(after); reused["Dataset"]["Subject"]["@id"] = OLD_PERSON
        self.assertEqual(r.only_reviewed_instance_mapping(before, reused, rebuilt_template()), "/Dataset/Subject/@id")
        lost = copy.deepcopy(after); lost["Dataset"]["@id"] = r.ELEMENT_INSTANCE_BASE + "33333333-3333-4333-8333-333333333333"
        self.assertEqual(r.only_reviewed_instance_mapping(before, lost, rebuilt_template()), "/Dataset/@id")
        restamped = copy.deepcopy(after); restamped["pav:lastUpdatedOn"] = "2026-01-01T00:00:00-08:00"
        self.assertEqual(r.only_reviewed_instance_mapping(before, restamped, rebuilt_template()), "/pav:lastUpdatedOn")
        remapped = copy.deepcopy(after); remapped["@context"]["schema"] = "http://x/other"
        self.assertEqual(r.only_reviewed_instance_mapping(before, remapped, rebuilt_template()), "/@context/schema")

    def test_a_plan_must_account_for_every_entered_value_and_match_its_template(self):
        before = old_structure_instance()
        r.INSTANCE_MAPPING_PLANS[before["@id"]]["drop"] = []
        with self.assertRaises(r.TransformRefused):
            r.apply_reviewed_instance_mapping(before, rebuilt_template())
        r.INSTANCE_MAPPING_PLANS[before["@id"]] = {**mapping_plan(), "drop": ["/Person/Name", "/Data/0/Missing"]}
        with self.assertRaises(r.TransformRefused):
            r.apply_reviewed_instance_mapping(before, rebuilt_template())
        r.INSTANCE_MAPPING_PLANS[before["@id"]] = {**mapping_plan(), "template": "https://repo.metadatacenter.org/templates/other"}
        with self.assertRaises(r.TransformRefused):
            r.apply_reviewed_instance_mapping(before, rebuilt_template())
        r.INSTANCE_MAPPING_PLANS.clear()
        self.assertEqual(r.apply_reviewed_instance_mapping(before, rebuilt_template()), (before, []))
        self.assertIn("apply-reviewed-instance-mapping", r.VALUE_DELETING_REPAIRS)


class RegistrationTest(unittest.TestCase):
    def test_the_chain_composes_and_leaves_provenance_alone(self):
        names = ["write-link-as-iri", "write-date-as-iso", "empty-placeholder-value", "restamp-declared-value-type"]
        repairs = [r.REPAIRS[name] for name in names]
        self.assertTrue(all(repair.needs_template for repair in repairs))
        before = instance(Visit={"@value": "2019-4-3", "@type": "xsd:dateTime"}, Page={"@id": "www.example.org"},
                          Weight={"@value": "n/a", "@type": "xsd:decimal"})
        after, changes = r.apply_repairs(repairs, before, template())
        self.assertEqual(after["Visit"], {"@value": "2019-04-03", "@type": "xsd:date"})
        self.assertEqual(after["Page"], {"@id": "https://www.example.org"})
        self.assertEqual(after["Weight"], {"@value": None, "@type": "xsd:decimal"})
        self.assertEqual(sorted(change["repair"] for change in changes), sorted(names))
        self.assertEqual({k: after[k] for k in PROVENANCE}, {k: before[k] for k in PROVENANCE})


if __name__ == "__main__":
    unittest.main()
