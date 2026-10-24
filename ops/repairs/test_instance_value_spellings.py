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
