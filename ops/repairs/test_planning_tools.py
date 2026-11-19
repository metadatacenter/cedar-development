"""The planners that choose what a repair writes.

ctxreq_at_risk.py writes the list of templates that can take a completed ``@context.required``
without invalidating an instance they already have, and plan_from_snapshot.py writes the
``--only-ids`` list an ``--apply`` run of the repair tool takes. The repair tool repeats its own
checks before every write, so a wrong plan costs a misleading list rather than a bad write, but the
operator chooses the population from these lists. The deployment, the snapshot and the library
bridges are stand-ins here; what is under test is which artifacts each planner selects.
"""
import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import cedar_artifact_repair as r
import ctxreq_at_risk
import plan_from_snapshot

TEMPLATE_PREFIX = "https://repo.metadatacenter.org/templates/"


class ContextRequiredAtRiskTest(unittest.TestCase):
    """Only a template whose complete dependent inventory gains no invalid instance is safe."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.key = self.folder / "key"
        self.key.write_text("test-key\n")
        self.out = self.folder / "impact.jsonl"
        self.safe = self.folder / "impact-safe.json"
        self.bridge = mock.Mock()

    def run_planner(self, outcomes):
        """Run main over one template per entry of ``outcomes``: a row check_template answers, or
        an exception it raises."""
        templates = {f"{TEMPLATE_PREFIX}{name}": outcome for name, outcome in outcomes.items()}
        listed = self.folder / "templates.json"
        listed.write_text(json.dumps(sorted(templates)))

        def check_template(_client, _bridge, template_id, proposed, stored=None):
            self.assertIn("@context", proposed)
            outcome = templates[template_id]
            if isinstance(outcome, BaseException):
                raise outcome
            return dict(outcome, templateId=template_id)

        client = mock.Mock()
        client.get_json.side_effect = lambda path: {"@context": {}, "path": path}
        argv = ["ctxreq_at_risk.py", "--api-key-file", str(self.key), "--templates", str(listed),
                "--out", str(self.out), "--java-log", str(self.folder / "java.log")]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(ctxreq_at_risk.impact.rest, "GetOnlyClient", return_value=client), \
                mock.patch.object(ctxreq_at_risk.audit, "resolve_toolchain", return_value=("java", "classes")), \
                mock.patch.object(ctxreq_at_risk.audit, "ValidationBridge", return_value=self.bridge), \
                mock.patch.object(ctxreq_at_risk.impact, "check_template", side_effect=check_template), \
                mock.patch.object(ctxreq_at_risk.repair, "complete_context_required",
                                  side_effect=lambda stored: (stored, [{"path": "/x"}])), \
                contextlib.redirect_stdout(io.StringIO()):
            return ctxreq_at_risk.main()

    def safe_list(self):
        return json.loads(self.safe.read_text())

    def test_only_a_complete_inventory_with_no_new_invalid_instance_is_safe(self):
        code = self.run_planner({
            "safe": {"complete": True, "outcome": "no-new-invalid-instances"},
            "incomplete": {"complete": False, "outcome": "no-new-invalid-instances"},
            "breaks": {"complete": True, "outcome": "new-invalid-instances"},
            "unreadable": RuntimeError("instance 7 could not be read"),
        })
        self.assertEqual(1, code)
        self.assertEqual([f"{TEMPLATE_PREFIX}safe"], self.safe_list())
        rows = {row["templateId"]: row for row in map(json.loads, self.out.read_text().splitlines())}
        self.assertEqual("inconclusive", rows[f"{TEMPLATE_PREFIX}unreadable"]["outcome"])
        self.assertFalse(rows[f"{TEMPLATE_PREFIX}unreadable"]["complete"])
        self.bridge.close.assert_called_once()

    def test_every_template_safe_exits_zero(self):
        self.assertEqual(0, self.run_planner({
            "a": {"complete": True, "outcome": "no-new-invalid-instances"},
            "b": {"complete": True, "outcome": "no-new-invalid-instances"}}))
        self.assertEqual([f"{TEMPLATE_PREFIX}a", f"{TEMPLATE_PREFIX}b"], self.safe_list())

    def test_an_interrupted_run_leaves_no_earlier_safe_list(self):
        self.safe.write_text(json.dumps([f"{TEMPLATE_PREFIX}from-an-earlier-run"]))
        with self.assertRaises(KeyboardInterrupt):
            self.run_planner({"a": {"complete": True, "outcome": "no-new-invalid-instances"},
                              "b": KeyboardInterrupt()})
        self.assertEqual([], self.safe_list())


INSTANCE_PREFIX = "https://repo.metadatacenter.org/template-instances/"
TEMPLATE = TEMPLATE_PREFIX + "t"


def touch(instance, _template):
    """A stand-in repair: it renames the instance, unless told to do something else."""
    action = instance.get("action")
    if action == "refuse":
        raise r.TransformRefused("nothing proves the change")
    if action == "nothing":
        return instance, []
    changed = dict(instance, **{"schema:name": "renamed"})
    if action == "move-provenance":
        changed["pav:lastUpdatedOn"] = "2026-11-16T00:00:00Z"
    return changed, [{"path": "/schema:name", "replaced": instance.get("schema:name"), "wrote": "renamed"}]


TOUCH = r.Repair(name="touch-for-planning", condition="planning", summary="stand-in",
                 transform=touch, invariant=lambda before, after, template: None, needs_template=True)


class StandInSnapshot:
    BODIES = {}

    def __init__(self, path):
        self.path = pathlib.Path(path)

    def artifacts(self, types=None):
        yield {"type": "template", "id": TEMPLATE}, json.dumps({"@id": TEMPLATE}).encode()
        for identifier, body in self.BODIES.items():
            yield {"type": "instance", "id": identifier}, json.dumps(body).encode()


class StandInLineBridge:
    """The Java bridge judges by the instance's ``verdict``, the TypeScript one reads by ``reading``."""

    def __init__(self, command):
        self.java = command[0] == "java"

    def ask(self, header, body):
        if header["op"] == "template":
            return {"status": "kept"}
        document = json.loads(body)
        if self.java:
            return {"reader": {"status": "read"},
                    "validation": {"status": document.get("verdict", "valid"),
                                   "errors": [{"message": "still refused"}]}}
        reading = document.get("reading", "read")
        return {"reader": {"status": "read", "lenient": {"status": reading}}}

    def close(self):
        pass


class PlanFromSnapshotTest(unittest.TestCase):
    """An instance is finished only when the chain changes it, keeps its provenance, and the
    validator and every reader accept the candidate."""

    def test_only_instances_every_check_accepts_are_finished(self):
        def instance(name, **extra):
            return {"@id": INSTANCE_PREFIX + name, "schema:isBasedOn": TEMPLATE, "schema:name": name,
                    "pav:lastUpdatedOn": "2020-01-01T00:00:00Z", **extra}
        StandInSnapshot.BODIES = {INSTANCE_PREFIX + name: instance(name, **extra) for name, extra in {
            "finished": {}, "refused": {"action": "refuse"}, "clean": {"action": "nothing"},
            "moved": {"action": "move-provenance"}, "invalid": {"verdict": "invalid"},
            "unreadable": {"reading": "refused"}}.items()}
        wanted = sorted(StandInSnapshot.BODIES) + [INSTANCE_PREFIX + "absent"]
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            ids = folder / "ids.json"
            ids.write_text(json.dumps(wanted))
            out = folder / "plan"
            with mock.patch.dict(r.REPAIRS, {TOUCH.name: TOUCH}), \
                    mock.patch.object(plan_from_snapshot, "Snapshot", StandInSnapshot), \
                    mock.patch.object(plan_from_snapshot, "LineBridge", StandInLineBridge), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, plan_from_snapshot.main([
                    "--snapshot", str(folder / "snapshot.tar.zst"), "--ids", str(ids), "--repair", TOUCH.name,
                    "--java-classpath", "classes", "--ts-library", "index.js", "--out", str(out)]))
            outcomes = {row["id"].rsplit("/", 1)[-1]: row["outcome"]
                        for row in map(json.loads, (out / "plan.jsonl").read_text().splitlines())}
            self.assertEqual({"finished": "would-finish", "refused": "refused", "clean": "no-change",
                              "moved": "provenance-moved", "invalid": "still-invalid",
                              "unreadable": "unreadable", "absent": "not-in-snapshot"}, outcomes)
            self.assertEqual([INSTANCE_PREFIX + "finished"], json.loads((out / "finished-ids.json").read_text()))
            self.assertEqual([{"artifactType": "instance", "artifactId": INSTANCE_PREFIX + "finished",
                               "conditionRules": {plan_from_snapshot.CONDITION: 1}}],
                             [json.loads(line) for line in (out / "targets.jsonl").read_text().splitlines()])


if __name__ == "__main__":
    unittest.main()
