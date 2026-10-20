"""Offline region persistence and listener readiness regressions."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
import wb_proxy


class StartupTests(unittest.TestCase):
    def test_invalid_explicit_region_fails_instead_of_using_default(self):
        with patch.dict(os.environ, {'WB_PROXY_REALM': 'invalid'}):
            with self.assertRaisesRegex(ValueError, 'cn or intl'):
                wb_proxy.load_persisted_realm()

    def test_empty_store_and_no_override_use_default_region(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(wb_proxy, 'ACCOUNTS_DIR', directory), \
                patch.object(wb_proxy, 'CURRENT_REALM', 'intl'), \
                patch.dict(os.environ, {'WB_PROXY_REALM': ''}):
            self.assertEqual(wb_proxy.load_persisted_realm(), 'intl')

    def test_region_round_trip_uses_configured_account_directory(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(wb_proxy, 'ACCOUNTS_DIR', directory), \
                patch.object(wb_proxy, 'CURRENT_REALM', 'intl'), \
                patch.dict(os.environ, {'WB_PROXY_REALM': ''}), \
                patch.object(wb_proxy, 'log'):
            wb_proxy.save_persisted_realm('cn')
            state = Path(directory) / 'active_realm.json'
            self.assertTrue(state.exists())
            self.assertEqual(json.loads(state.read_text())['realm'], 'cn')
            wb_proxy.CURRENT_REALM = 'intl'
            self.assertEqual(wb_proxy.load_persisted_realm(), 'cn')

    def test_explicit_host_region_overrides_saved_region(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(wb_proxy, 'ACCOUNTS_DIR', directory), \
                patch.object(wb_proxy, 'CURRENT_REALM', 'intl'), \
                patch.dict(os.environ, {'WB_PROXY_REALM': 'cn'}):
            (Path(directory) / 'active_realm.json').write_text('{"realm":"intl"}')
            self.assertEqual(wb_proxy.load_persisted_realm(), 'cn')
