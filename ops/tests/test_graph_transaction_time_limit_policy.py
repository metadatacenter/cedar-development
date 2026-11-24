#!/usr/bin/env python3
"""Static guard against graph transactions that carry no time limit.

Neo4j ends a transaction that outlives the limit the driver sends with it, and no server setting does
so on any CEDAR host. A graph transaction opened without a limit can therefore wait on a lock, or run,
for as long as it takes. Every transaction a backend service opens names one of the limits in
``GraphTransactionTimeouts``, or the ``TransactionConfig`` a caller passed in.
"""

import re
import tempfile
import unittest
from pathlib import Path


CEDAR_HOME = Path(__file__).resolve().parents[3]
BACKEND_REPOSITORIES = sorted(CEDAR_HOME.glob("cedar-*-server")) + [
    CEDAR_HOME / "cedar-microservice-libraries"
]

# A session's ways of running work against the graph. A transaction's own run() runs inside a
# transaction that already carries its limit, so only a session's run() opens one.
TRANSACTION_CALL = re.compile(
    r'\b(?P<receiver>\w+)\s*\.\s*(?P<method>writeTransaction|readTransaction|executeWrite|executeRead'
    r'|beginTransaction|run)\s*\('
)
SESSION_RECEIVER = re.compile(r'^session$')
LIMIT = re.compile(r'\bGraphTransactionTimeouts\s*\.|\btxConfig\b')


def _closing_parenthesis(text, start):
    depth = 1
    index = start
    while index < len(text):
        character = text[index]
        if character in "\"'":
            if text.startswith('"""', index):
                end = text.index('"""', index + 3)
                index = end + 3
                continue
            index += 1
            while text[index] != character:
                index += 2 if text[index] == "\\" else 1
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("unbalanced parentheses")


def unlimited_transactions(path, text):
    """The calls in one Java source that open a graph transaction without naming a limit."""
    violations = []
    for match in TRANSACTION_CALL.finditer(text):
        method = match.group("method")
        if method == "run" and not SESSION_RECEIVER.match(match.group("receiver")):
            continue
        arguments = text[match.end():_closing_parenthesis(text, match.end())]
        if not LIMIT.search(arguments):
            line = text.count("\n", 0, match.start()) + 1
            violations.append(f"{path}:{line}: {match.group('receiver')}.{method} carries no time limit")
    return violations


def backend_main_sources(repository):
    return [path for source_root in repository.glob("**/src/main/java") if "/target/" not in str(source_root)
            for path in source_root.rglob("*.java")]


def opens_graph_sessions(text):
    return "org.neo4j.driver" in text


class GraphTransactionTimeLimitPolicyTest(unittest.TestCase):

    def test_every_graph_transaction_carries_a_time_limit(self):
        violations = []
        scanned = 0
        for repository in BACKEND_REPOSITORIES:
            if not repository.is_dir():
                continue
            for path in backend_main_sources(repository):
                text = path.read_text(encoding="utf-8")
                if not opens_graph_sessions(text):
                    continue
                scanned += 1
                violations.extend(unlimited_transactions(path.relative_to(CEDAR_HOME), text))
        if scanned == 0:
            self.skipTest("no backend repository is checked out beside cedar-development")
        self.assertEqual([], violations, "\n".join(violations))

    def test_policy_rejects_a_transaction_without_a_limit(self):
        source = """
            try (var session = driver.session(); var tx = session.beginTransaction()) {
              session.writeTransaction(tx -> tx.run("MATCH (n) RETURN n").list());
              session.run("MATCH (n {id:$id}) RETURN n", Map.of("id", id));
            }
            """
        self.assertEqual(3, len(unlimited_transactions(Path("Example.java"), source)))

    def test_policy_accepts_a_limit_and_ignores_a_transactions_own_run(self):
        source = """
            try (var session = driver.session();
                 var tx = session.beginTransaction(GraphTransactionTimeouts.request())) {
              tx.run("MATCH (n) RETURN n").consume();
              session.writeTransaction(tx -> {
                return tx.run("RETURN ')'").single();
              }, GraphTransactionTimeouts.aroundACall());
              session.readTransaction(work, txConfig);
              session.run("CREATE INDEX x IF NOT EXISTS FOR (n:N) ON (n.p)",
                  GraphTransactionTimeouts.longRunning()).consume();
            }
            """
        self.assertEqual([], unlimited_transactions(Path("Example.java"), source))

    def test_a_repository_without_main_sources_yields_nothing_to_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "cedar-example-server"
            repository.mkdir()
            self.assertEqual([], backend_main_sources(repository))


if __name__ == "__main__":
    unittest.main()
