#!/usr/bin/env python3
"""Static guard against fixed or wildcard-scoped backend test listeners."""

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
HTTP_CONNECTOR = re.compile(r'^(?P<indent>\s*)-\s*type:\s*http\s*$', re.MULTILINE)
INET_SOCKET_ADDRESS = re.compile(r'new\s+InetSocketAddress\((?P<args>[^\n;]+?)\)')
WILDCARD_SERVER_SOCKET = re.compile(r'new\s+ServerSocket\(\s*0\s*\)')
ZERO_PORT = re.compile(r'(?:^|,)\s*0\s*$')


def _line_number(text, offset):
    return text.count("\n", 0, offset) + 1


def _connector_body(text, match):
    connector_indent = len(match.group("indent"))
    lines = text[match.end():].splitlines()
    body = []
    for line in lines:
        if not line.strip():
            continue
        indentation = len(line) - len(line.lstrip())
        if indentation <= connector_indent:
            break
        body.append(line)
    return "\n".join(body)


def listener_violations(path, text):
    violations = []
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
                violations.append((_line_number(text, match.start()), f"fixed port {port}"))

    if path.suffix in {".yml", ".yaml"}:
        for match in HTTP_CONNECTOR.finditer(text):
            if not re.search(r'^\s*bindHost:\s*127\.0\.0\.1\s*$',
                             _connector_body(text, match), re.MULTILINE):
                violations.append((
                    _line_number(text, match.start()),
                    "HTTP connector does not bind 127.0.0.1",
                ))
        return violations

    for match in INET_SOCKET_ADDRESS.finditer(text):
        arguments = match.group("args")
        if ZERO_PORT.search(arguments) and not re.fullmatch(
                r'\s*"127\.0\.0\.1"\s*,\s*0\s*', arguments):
            violations.append((
                _line_number(text, match.start()),
                "port-0 InetSocketAddress does not bind 127.0.0.1",
            ))
    for match in WILDCARD_SERVER_SOCKET.finditer(text):
        violations.append((
            _line_number(text, match.start()),
            "port-0 ServerSocket uses the wildcard address",
        ))
    for match in re.finditer(r'new\s+ServerSocket\([^;]*?;', text, re.DOTALL):
        expression = match.group(0)
        if re.search(r'new\s+ServerSocket\(\s*0\s*,', expression) \
                and 'InetAddress.getByName("127.0.0.1")' not in expression:
            violations.append((
                _line_number(text, match.start()),
                "port-0 ServerSocket does not bind 127.0.0.1",
            ))
    for match in re.finditer(r'\.setPort\(\s*0\s*\)', text):
        if '--bind-address=127.0.0.1' not in text:
            violations.append((
                _line_number(text, match.start()),
                "embedded SQL port allocation has no loopback bind address",
            ))
    return violations


class BackendTestPortPolicyTest(unittest.TestCase):

    def test_backend_tests_do_not_bind_fixed_ports(self):
        violations = []
        for repository in BACKEND_REPOSITORIES:
            source_roots = list(repository.glob("**/src/test"))
            if repository.name == "cedar-microservice-libraries":
                source_roots.append(
                    repository / "cedar-test-support-library" / "src" / "main")
            for source_root in source_roots:
                for path in source_root.rglob("*"):
                    if not path.is_file() or path.suffix not in {".java", ".yml", ".yaml"}:
                        continue
                    text = path.read_text(encoding="utf-8")
                    for line, message in listener_violations(path, text):
                        violations.append(
                            f"{path.relative_to(CEDAR_HOME)}:{line}: {message}")

        self.assertEqual(
            [],
            violations,
            "Backend tests must bind listeners on 127.0.0.1:0; use 127.0.0.1:1 only for an "
            "intentionally unavailable dependency. Intentional external services such as "
            "OpenSearch are selected by REST/transport variables and are outside this listener "
            "policy:\n"
            + "\n".join(violations),
        )

    def test_policy_rejects_wildcard_listeners(self):
        yaml = """server:
  applicationConnectors:
  - type: http
    port: 0
"""
        java = """new ServerSocket(0);
HttpServer.create(new InetSocketAddress(0), 0);
"""

        self.assertEqual(
            [(3, "HTTP connector does not bind 127.0.0.1")],
            listener_violations(Path("test-config.yml"), yaml),
        )
        messages = [message for _, message in listener_violations(Path("Test.java"), java)]
        self.assertIn("port-0 ServerSocket uses the wildcard address", messages)
        self.assertIn("port-0 InetSocketAddress does not bind 127.0.0.1", messages)


if __name__ == "__main__":
    unittest.main()
