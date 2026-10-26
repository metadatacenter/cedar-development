import copy
import json
from pathlib import Path
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import frontend_inventory


class FrontendInventoryTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((Path(__file__).resolve().parents[1] / 'frontend-train.json').read_text())

    def test_current_graph_is_completely_covered(self):
        self.assertEqual(15, len(frontend_inventory.validate(self.config)))

    def test_new_component_or_consumer_requires_verification(self):
        for item in ({'id':'new', 'repository':'new-component', 'consumers':[]},
                     {'id':'new', 'repository':'cedar-design-tokens', 'consumers':[
                         {'repository':'new-app', 'manifest':'ui/package.json'}]}):
            config = copy.deepcopy(self.config)
            config['components'].append(item)
            with self.assertRaisesRegex(ValueError, 'coverage missing'):
                frontend_inventory.validate(config)

    def test_missing_checks_require_an_explicit_reason(self):
        self.config['surfaces'][0]['verify'] = []
        with self.assertRaisesRegex(ValueError, 'neither verification nor an exemption'):
            frontend_inventory.validate(self.config)
        self.config['surfaces'][0]['verificationExemption'] = 'No executable source'
        frontend_inventory.validate(self.config)

    def test_exemptions_must_be_written_reasons_not_truthy_placeholders(self):
        self.config['surfaces'][0]['verify'] = []
        for value in (None, True, 1, [], '  '):
            self.config['surfaces'][0]['verificationExemption'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'neither verification nor an exemption'):
                frontend_inventory.validate(self.config)

    def test_duplicates_and_unsafe_paths_fail(self):
        self.config['surfaces'].append(copy.deepcopy(self.config['surfaces'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            frontend_inventory.validate(self.config)
        self.config['surfaces'].pop()
        self.config['surfaces'][0]['directory']='../outside'
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            frontend_inventory.validate(self.config)

    def test_a_package_phase_runs_between_setup_and_verification(self):
        commands = frontend_inventory.commands(self.config, 'cedar-embeddable-editor')
        package = commands.index(['npm', 'run', 'package:npm:prebuilt'])
        self.assertLess(commands.index(['npm', '--prefix', 'visual', 'ci']), commands.index(['npm', 'run', 'build:production']))
        self.assertLess(commands.index(['npm', 'run', 'build:production']), package)
        self.assertEqual([['npm', 'run', 'test:ci:prebuilt']], commands[package + 1:])

    def test_package_commands_are_validated_like_the_others(self):
        row = next(r for r in self.config['surfaces'] if r['repository'] == 'cedar-embeddable-editor')
        for value in ([[]], [['npm', '']], 'npm run build'):
            row['package'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid package commands'):
                frontend_inventory.validate(self.config)

    def test_split_apps_build_before_their_browser_checks(self):
        for repository in ('cedar-monitoring', 'cedar-bridging', 'cedar-openview'):
            with self.subTest(repository=repository):
                commands = frontend_inventory.commands(self.config, repository, repository + '-src')
                built = commands.index(['npm', 'run', 'build'])
                self.assertLess(commands.index(['npm', '--prefix', '../browser', 'ci']), built)
                self.assertLess(commands.index(['../browser/node_modules/.bin/playwright', 'install', '--with-deps', 'chromium']), built)
                self.assertLess(built, commands.index(['npm', '--prefix', '../browser', 'test']))

    def test_workspace_checks_the_built_ui_in_the_visual_container(self):
        commands = frontend_inventory.commands(self.config, 'cedar-workspace')
        built = commands.index(['npm', 'run', 'build'])
        self.assertLess(commands.index(['npm', 'test']), built)
        self.assertLess(built, commands.index(['npm', 'run', 'test:visual']))

    def test_designer_installs_both_engines_before_its_complete_gate(self):
        commands = frontend_inventory.commands(self.config, 'cedar-embeddable-designer')
        self.assertLess(commands.index(['./browser/node_modules/.bin/playwright', 'install',
                                        '--with-deps', 'chromium', 'webkit']),
                        commands.index(['npm', 'run', 'test:ci']))

    def test_all_three_framework_demos_have_lint_and_tests(self):
        for directory in ('cedar-cee-demo-angular-src','cedar-cee-demo-ember-src','cedar-cee-demo-react'):
            commands = frontend_inventory.commands(self.config,'cedar-component-demo',directory)
            self.assertIn(['npm','run','lint'],commands)
            self.assertTrue(any(c[-1] in ('test','test:ember') for c in commands))
