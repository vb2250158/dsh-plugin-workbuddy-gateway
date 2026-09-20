"""Verify realm persistence follows the configured account directory."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
import wb_proxy


class RealmPersistenceTests(unittest.TestCase):
    def test_save_and_reload_use_directory_selected_after_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'profile-accounts'
            with patch.object(wb_proxy, 'ACCOUNTS_DIR', str(directory)), \
                    patch.object(wb_proxy, 'CURRENT_REALM', 'intl'), \
                    patch.object(wb_proxy, 'log'):
                wb_proxy.save_persisted_realm('cn')
                state = json.loads((directory / 'active_realm.json').read_text(encoding='utf-8'))
                self.assertEqual(state['realm'], 'cn')
                wb_proxy.CURRENT_REALM = 'intl'
                self.assertEqual(wb_proxy.load_persisted_realm(), 'cn')

    def test_switching_account_directories_keeps_their_realms_separate(self):
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(wb_proxy, 'CURRENT_REALM', 'intl'), \
                patch.object(wb_proxy, 'log'):
            first = str(Path(temporary) / 'first')
            second = str(Path(temporary) / 'second')
            with patch.object(wb_proxy, 'ACCOUNTS_DIR', first):
                wb_proxy.save_persisted_realm('cn')
            with patch.object(wb_proxy, 'ACCOUNTS_DIR', second):
                wb_proxy.save_persisted_realm('intl')
            with patch.object(wb_proxy, 'ACCOUNTS_DIR', first):
                self.assertEqual(wb_proxy.load_persisted_realm(), 'cn')
            with patch.object(wb_proxy, 'ACCOUNTS_DIR', second):
                self.assertEqual(wb_proxy.load_persisted_realm(), 'intl')


if __name__ == '__main__':
    unittest.main()
