import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import npm_lock_availability


NEXUS = "https://nexus.bmir.stanford.edu/repository/"


def integrity(content: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()


class NpmLockAvailabilityTest(unittest.TestCase):
    def write_lock(self, root: Path) -> Path:
        lock = root / "package-lock.json"
        lock.write_text(json.dumps({"packages": {
            "": {"dependencies": {}},
            "node_modules/left-pad": {
                "version": "1.3.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
                "integrity": integrity(b"public"),
            },
            "node_modules/@org.metadatacenter/cedar-design-tokens": {
                "version": "0.1.0-dev.cached",
                "resolved": NEXUS + "npm-cedar/tokens-cached.tgz",
                "integrity": integrity(b"cached"),
            },
            "node_modules/cedar-embeddable-designer": {
                "version": "0.1.0-dev.served",
                "resolved": NEXUS + "npm-cedar-releases/designer-served.tgz",
                "integrity": integrity(b"served"),
            },
            "node_modules/cedar-embeddable-term-picker": {
                "version": "0.1.0-dev.purged",
                "resolved": NEXUS + "npm-cedar/picker-purged.tgz",
                "integrity": integrity(b"purged"),
            },
        }}), encoding="utf-8")
        return lock

    @staticmethod
    def cache_content(cache: Path, content: bytes) -> None:
        digest = hashlib.sha512(content).hexdigest()
        path = cache / "_cacache" / "content-v2" / "sha512" / digest[:2] / digest[2:4] / digest[4:]
        path.parent.mkdir(parents=True)
        path.write_bytes(content)

    def test_names_only_the_nexus_tarball_neither_served_nor_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = self.write_lock(root)
            self.cache_content(root / "cache", b"cached")
            asked = []

            def published(url):
                asked.append(url)
                return url.endswith("designer-served.tgz")

            stderr = io.StringIO()
            with patch.object(npm_lock_availability, "published", side_effect=published), \
                    contextlib.redirect_stderr(stderr):
                code = npm_lock_availability.main([str(lock), "--cache", str(root / "cache")])

            self.assertEqual(1, code)
            # The cached tarball costs no request, and npmjs is not asked about at all.
            self.assertEqual([NEXUS + "npm-cedar-releases/designer-served.tgz",
                              NEXUS + "npm-cedar/picker-purged.tgz"], asked)
            report = stderr.getvalue()
            self.assertIn("cedar-embeddable-term-picker@0.1.0-dev.purged", report)
            self.assertNotIn("designer-served", report)
            self.assertNotIn("cedar-design-tokens", report)
            self.assertIn("npm cache add", report)

    def test_a_lock_whose_nexus_tarballs_all_resolve_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = self.write_lock(root)
            with patch.object(npm_lock_availability, "published", return_value=True):
                code = npm_lock_availability.main([str(lock), "--cache", str(root / "cache")])
            self.assertEqual(0, code)

    def test_a_registry_failure_other_than_404_is_not_reported_as_purged(self):
        error = npm_lock_availability.urllib.error.HTTPError(
            NEXUS + "x.tgz", 500, "Server Error", {}, None)
        with patch.object(npm_lock_availability.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(npm_lock_availability.urllib.error.HTTPError):
                npm_lock_availability.published(NEXUS + "x.tgz")


if __name__ == "__main__":
    unittest.main()
