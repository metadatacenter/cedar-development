import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).parents[1] / 'cedar_search_readonly_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class SearchReadonlyProbeTest(unittest.TestCase):
    def test_authenticated_origins_reject_downgrades_credentials_and_paths(self):
        self.assertEqual('https://resource.example', probe.origin('https://resource.example/'))
        for value in ('http://resource.example', 'https://user:password@resource.example',
                      'https://resource.example/search', 'https://resource.example?key=secret'):
            with self.assertRaises(ValueError):
                probe.origin(value)

    def test_redirects_are_never_followed(self):
        with self.assertRaises(RuntimeError):
            probe.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example')

    def test_pagination_detects_both_production_failures(self):
        issues = probe.paging_issues('https://resource.example', '"Dried blood spot"',
            {'next': 'http://resource.example/search?q=%22Dried%2Bblood%2Bspot%22&offset=3'})
        self.assertEqual(['pagination-origin', 'pagination-query'], [i['kind'] for i in issues])
        self.assertEqual([], probe.paging_issues('https://resource.example', '"Dried blood spot"',
            {'next': '/search?q=%22Dried+blood+spot%22&offset=3'}))

    def test_invariant_findings_do_not_require_an_inventory(self):
        records = [{'endpoint': 'search', 'query': q, 'status': status, 'totalCount': count}
                   for q, status, count in [('Sex:Male', 200, 20), ('Sex: Male', 200, 30),
                                             ('"Rad', 500, None)]]
        findings = probe.analyze(records, 'https://resource.example')
        self.assertEqual({'status', 'equivalent-counts'}, {f['kind'] for f in findings})


if __name__ == '__main__':
    unittest.main()
