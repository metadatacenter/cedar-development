import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {beginHistory, finishHistory, sourceIdentity} from "./journey-history.mjs";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "journey-history-test-")), cwd = join(root, "e2e");
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const write = (path, text = "{}") => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, text);
  };
  write("journey.mjs", 'import "./rest/lib.mjs";');
  write("rest/lib.mjs", 'export const result = "original";');
  const git = args => execFileSync("git", args, {cwd, stdio: "pipe"});
  git(["init", "-q"]);
  git(["add", "journey.mjs", "rest/lib.mjs"]);
  git(["-c", "user.name=Harness", "-c", "user.email=harness@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return {cwd, write, directory: join(root, "history")};
}

test("nested helper edits, additions and deletions change source identity without a new commit", t => {
  const {cwd, write} = workspace(t), original = sourceIdentity(cwd);
  write("rest/lib.mjs", 'export const result = "changed";');
  const edited = sourceIdentity(cwd);
  assert.equal(edited.head, original.head);
  assert.notEqual(edited.testDigest, original.testDigest);
  write("rest/search/fixture.json");
  const added = sourceIdentity(cwd);
  assert.notEqual(added.testDigest, edited.testDigest);
  rmSync(join(cwd, "rest/search/fixture.json"));
  assert.equal(sourceIdentity(cwd).testDigest, edited.testDigest);
  rmSync(join(cwd, "rest/lib.mjs"));
  assert.notEqual(sourceIdentity(cwd).testDigest, edited.testDigest);
});

test("reports, dependency trees, failures and saved sessions do not change source identity", t => {
  const {cwd, write} = workspace(t), original = sourceIdentity(cwd).testDigest;
  for (const path of ["reports/journey-history/run.json", "rest/reports/run.json", "node_modules/pkg/index.js",
    "rest/node_modules/pkg/package.json", "failures/failure.json", ".auth/session.json"])
    write(path);
  assert.equal(sourceIdentity(cwd).testDigest, original);
});

test("retry linkage refuses a changed imported helper and accepts unchanged sources", t => {
  const {cwd, write, directory} = workspace(t);
  const options = {cwd, directory, kind: "split", selection: ["folder-ui"]};
  const first = beginHistory(options);
  finishHistory(first, {verdict: "FAIL", units: [], reportPath: "first.json"}, directory);
  assert.equal(beginHistory({...options, retryOf: first.id}).firstAttempt, first.id);
  write("rest/lib.mjs", 'export const result = "fixed";');
  assert.throws(() => beginHistory({...options, retryOf: first.id}), /same sources/);
});
