import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from frontend_payload import measure


class PagePayloadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.spec = {'initial': {'raw': 1000, 'gzip': 1000}, 'total': {'raw': 2000, 'gzip': 2000}}
        for name, contents in {'main.js': 'main', 'shared.js': 'shared', 'lazy.js': 'lazy',
                               'styles.css': 'styles', 'copied.js': 'component'}.items():
            (self.root / name).write_text(contents)
        (self.root / 'index.html').write_text('<script src="/main.js"></script><link rel="stylesheet" href="styles.css">')
        (self.root / 'browser-stats.json').write_text(json.dumps({'outputs': {'main.js': {'imports': [
            {'path': 'shared.js', 'kind': 'import-statement'}, {'path': 'lazy.js', 'kind': 'dynamic-import'}]}}}))

    def test_static_graph_css_and_copied_assets_are_measured_separately(self):
        report = measure(self.root, self.spec)
        self.assertEqual({'raw': 16, 'gzip': 76}, report['sizes']['initial'])
        self.assertEqual(29, report['sizes']['total']['raw'])
        self.assertFalse(report['assets']['copied.js']['initial'])
        self.assertFalse(report['assets']['lazy.js']['initial'])

    def test_added_script_tag_cannot_escape_the_initial_budget(self):
        self.spec['initial']['raw'] = 20
        with (self.root / 'index.html').open('a') as page:
            page.write('<script src="copied.js?v=new"></script>')
        self.assertTrue(measure(self.root, self.spec)['failures'])

    def test_unreferenced_asset_cannot_escape_the_total_budget(self):
        (self.root / 'new-component.js').write_text('x' * 2000)
        self.assertTrue(measure(self.root, self.spec)['failures'])

    def test_font_subsets_are_deferred_but_remain_in_the_total_budget(self):
        (self.root / 'styles.css').write_text("@font-face{src:url('./font.woff2')}")
        with self.assertRaises(ValueError):
            measure(self.root, self.spec)
        (self.root / 'font.woff2').write_bytes(b'font')
        report = measure(self.root, self.spec)
        self.assertFalse(report['assets']['font.woff2']['initial'])
        self.assertEqual(4, report['assets']['font.woff2']['raw'])
        (self.root / 'font.woff2').write_bytes(b'f' * 2000)
        self.assertTrue(measure(self.root, self.spec)['failures'])

    def test_missing_or_remote_script_fails_closed(self):
        for address in ['missing.js', 'https://cdn.example/component.js', '../outside.js']:
            (self.root / 'index.html').write_text(f'<script src="{address}"></script>')
            with self.subTest(address=address), self.assertRaises(ValueError):
                measure(self.root, self.spec)

    def test_extra_roots_count_runtime_copies_and_repeated_tags_once(self):
        extra = self.root / 'host-assets'
        extra.mkdir()
        (extra / 'auth.js').write_text('auth')
        self.spec['extraRoots'] = {'scripts': 'host-assets'}
        with (self.root / 'index.html').open('a') as page:
            page.write('<script src="/scripts/auth.js"></script><script src="main.js"></script>')
        report = measure(self.root, self.spec, self.root)
        self.assertEqual(20, report['sizes']['initial']['raw'])
        self.assertTrue(report['assets']['scripts/auth.js']['initial'])


if __name__ == '__main__':
    unittest.main()
