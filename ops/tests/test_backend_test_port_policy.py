#!/usr/bin/env python3
"""Static guard against reintroducing fixed backend test listeners."""

import re
import unittest
from pathlib import Path


CEDAR_HOME = Path(__file__).resolve().parents[3]
BACKEND_REPOSITORIES = sorted(CEDAR_HOME.glob("cedar-*-server")) + [
    CEDAR_HOME / "cedar-microservice-libraries"
]

ENVIRONMENT_PORT = re.compile(
    r'CEDAR_[A-Z0-9_]+_(?:HTTP|ADMIN|STOP)_PORT"\s*,\s*"(?P<port>\d+)"'
)
PORT_CONSTANT = re.compile(
    r'private\s+static\s+final\s+int\s+[A-Z0-9_]*PORT\s*=\s*(?P<port>\d+)'
)
SOCKET_LITERAL = re.compile(
    r'new\s+InetSocketAddress\([^\n]*?,\s*(?P<port>\d+)\s*\)'
)
YAML_PORT = re.compile(r'^\s*(?:testPort|port):\s*(?P<port>\d+)\s*$', re.MULTILINE)


class BackendTestPortPolicyTest(unittest.TestCase):

    def test_backend_tests_do_not_bind_fixed_ports(self):
        violations = []
        for repository in BACKEND_REPOSITORIES:
            for source_root in repository.glob("**/src/test"):
                for path in source_root.rglob("*"):
                    if not path.is_file() or path.suffix not in {".java", ".yml", ".yaml"}:
                        continue
                    text = path.read_text(encoding="utf-8")
                    patterns = (
                        (ENVIRONMENT_PORT, PORT_CONSTANT, SOCKET_LITERAL)
                        if path.suffix == ".java"
                        else (YAML_PORT,)
                    )
                    for pattern in patterns:
                        for match in pattern.finditer(text):
                            port = int(match.group("port"))
                            # 0 asks the OS to allocate a listener. Port 1 is the explicit CEDAR
                            # convention for a dependency that must be unavailable and is not bound.
                            if port not in {0, 1}:
                                line = text.count("\n", 0, match.start()) + 1
                                violations.append(f"{path.relative_to(CEDAR_HOME)}:{line}: port {port}")

        self.assertEqual(
            [],
            violations,
            "Backend tests must bind listeners on port 0; use port 1 only for an intentionally "
            "unavailable dependency. Intentional external services such as OpenSearch are selected "
            "by REST/transport variables and are outside this listener policy:\n"
            + "\n".join(violations),
        )


if __name__ == "__main__":
    unittest.main()
