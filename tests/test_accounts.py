"""Offline checks for local changes to the bundled account adapter."""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
import wb_accounts as accounts


class AccountTests(unittest.TestCase):
    def test_availability_tracks_cooldown_and_credentials_without_refresh_io(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(accounts.time, 'time', return_value=1000), \
                patch.object(accounts.Account, 'refresh', side_effect=AssertionError('status must not refresh')):
            pool = accounts.AccountPool(directory)
            pool.accounts = [accounts.Account({'uid': str(i), 'realm': 'intl', 'accessToken': 'fake', **data})
                             for i, data in enumerate([
                                 {'lastError': 'HTTP 403', 'cooldownUntil': 999},
                                 {'cooldownUntil': 1001},
                                 {'enabled': False},
                                 {'accessToken': ''},
                                 {'expiresAt': 900},
                                 {'expiresAt': 900, 'refreshToken': 'fake-refresh'},
                                 {'expiresAt': 1200},
                             ])]
            self.assertEqual([a.public()['available'] for a in pool.accounts],
                             [True, False, False, False, False, True, True])
            self.assertEqual(pool.count_ready('intl'), 3)
            self.assertTrue(pool.accounts[0].ready())
            with patch.object(accounts.time, 'time', return_value=1002):
                self.assertTrue(pool.accounts[1].public()['available'])
                self.assertEqual(pool.count_ready('intl'), 4)

    def test_http_already_claimed_is_persisted_and_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            account = accounts.Account({'uid': 'test', 'realm': 'cn', 'accessToken': 'fake'})
            account.save(directory)
            error = HTTPError('https://example.invalid', 400, 'Bad Request', {},
                              io.BytesIO(json.dumps({'code': 10001, 'msg': 'already claimed'}).encode()))
            with patch.object(accounts, 'http_json', side_effect=error):
                result = account.checkin()
            self.assertTrue(result['ok'])
            self.assertTrue(result['claimed'])
            restored = accounts.Account(json.loads(Path(account.path).read_text(encoding='utf-8')))
            self.assertTrue(restored.public()['checkinClaimed'])
            self.assertIsNotNone(restored.public()['lastCheckin'])

    def test_unrelated_http_error_does_not_mark_claimed(self):
        account = accounts.Account({'realm': 'cn', 'accessToken': 'fake'})
        error = HTTPError('https://example.invalid', 401, 'Unauthorized', {},
                          io.BytesIO(b'{"code":401,"msg":"token already expired"}'))
        with patch.object(accounts, 'http_json', side_effect=error):
            result = account.checkin()
        self.assertFalse(result['ok'])
        self.assertIsNone(account.checkin_claimed)
        self.assertIsNone(account.last_checkin)

    def test_success_and_rejected_checkins_have_distinct_state(self):
        for code, expected in [(0, True), (10001, True), (12345, False)]:
            with self.subTest(code=code):
                account = accounts.Account({'realm': 'cn', 'accessToken': 'fake'})
                with patch.object(accounts, 'http_json', return_value={'code': code}):
                    result = account.checkin()
                self.assertEqual(result['ok'], expected)
                self.assertEqual(account.checkin_claimed is True, expected)

    def test_checkin_status_expires_at_local_day_boundary(self):
        today = accounts.time.strftime('%Y-%m-%d')
        account = accounts.Account({
            'realm': 'cn', 'accessToken': 'fake',
            'checkinClaimed': True, 'lastCheckin': '2000-01-01 23:59:59',
        })
        self.assertFalse(account.public()['checkinClaimed'])

        account.last_checkin = today + ' 00:00:01'
        self.assertTrue(account.public()['checkinClaimed'])

    def test_import_reads_credits_after_cn_checkin(self):
        for realm in ('cn', 'intl'):
            with self.subTest(realm=realm), tempfile.TemporaryDirectory() as directory:
                credential = Path(directory) / 'desktop.info'
                credential.write_text(json.dumps({'auth': {'accessToken': 'fake'},
                                                 'account': {'uid': 'test'}}), encoding='utf-8')
                calls = []

                def checkin(account):
                    calls.append('checkin')
                    account.checkin_claimed = True
                    account.last_checkin = accounts.time.strftime('%Y-%m-%d %H:%M:%S')
                    return {'ok': True}

                def credits(account):
                    calls.append('credits')
                    account.credits = {'remain': 100}
                    return {'ok': True}

                pool = accounts.AccountPool(str(Path(directory) / 'pool'))
                with patch.object(accounts.Account, 'checkin', checkin), patch.object(accounts.Account, 'fetch_credits', credits):
                    imported = pool.import_desktop_credential(str(credential), realm=realm)
                self.assertEqual(calls, ['checkin', 'credits'] if realm == 'cn' else ['credits'])
                self.assertEqual(imported.public()['credits']['remain'], 100)
                self.assertEqual(imported.public()['checkinClaimed'], True if realm == 'cn' else None)

    def test_credits_prefer_precise_values_and_round_to_cents(self):
        account = accounts.Account({'uid': 'test', 'realm': 'intl', 'accessToken': 'fake'})
        upstream = {'data': {'Response': {'Data': {'Accounts': [
            {'PackageName': 'Bonus Pack', 'CycleCapacitySize': 250, 'CycleCapacityRemain': 247,
             'CycleCapacitySizePrecise': '250.00', 'CycleCapacityRemainPrecise': '247.87',
             'CycleCapacityUsedPrecise': '2.13', 'Status': 0},
        ]}}}}
        with patch.object(accounts.Account, 'headers', return_value={}), \
                patch.object(accounts, 'http_json', return_value=upstream):
            credits = account.fetch_credits()['credits']
        # The truncated integer would report 247; the desktop app shows 247.87.
        self.assertEqual(credits['remain'], 247.87)
        self.assertEqual(credits['packages'][0]['remain'], 247.87)
        self.assertEqual(credits['size'], 250.0)

    def test_expired_packages_are_excluded_from_the_usable_balance(self):
        account = accounts.Account({'uid': 'test', 'realm': 'intl', 'accessToken': 'fake'})
        upstream = {'data': {'Response': {'Data': {'Accounts': [
            {'PackageName': 'Active', 'CycleCapacitySizePrecise': '100.00',
             'CycleCapacityRemainPrecise': '55.67', 'Status': 0},
            {'PackageName': 'Expired', 'CycleCapacitySizePrecise': '500.00',
             'CycleCapacityRemainPrecise': '500.00', 'Status': 3},
        ]}}}}
        with patch.object(accounts.Account, 'headers', return_value={}), \
                patch.object(accounts, 'http_json', return_value=upstream):
            credits = account.fetch_credits()['credits']
        # Counting the expired package in would report 555.67.
        self.assertEqual(credits['remain'], 55.67)
        self.assertEqual(credits['expired'], 500.0)
        self.assertFalse(credits['packages'][1]['active'])
        self.assertTrue(credits['packages'][0]['active'])

    def test_precise_number_falls_back_and_ignores_booleans(self):
        self.assertEqual(accounts._precise_number({'CapacityRemain': 247}, 'CapacityRemain'), 247.0)
        self.assertEqual(accounts._precise_number(
            {'CapacityRemainPrecise': '247.87', 'CapacityRemain': 247}, 'CapacityRemain'), 247.87)
        self.assertEqual(accounts._precise_number({'CapacityRemainPrecise': 'n/a'}, 'CapacityRemain'), 0.0)
        self.assertEqual(accounts._precise_number({}, 'CapacityRemain'), 0.0)

    def test_package_name_fallback_chain(self):
        self.assertEqual(accounts._package_name({'PackageName': 'Named'}), 'Named')
        self.assertEqual(accounts._package_name({'SubProductName': 'Sub'}), 'Sub')
        self.assertEqual(accounts._package_name({'PackageCode': 'p_tcaca'}), 'p_tcaca')
        self.assertEqual(accounts._package_name({'PackageName': '   '}), 'Package')
        self.assertEqual(accounts._package_name({}), 'Package')
        # Float noise from summing precise strings must not survive to the wire.
        self.assertEqual(accounts.round_credits(655.67000031), 655.67)
        self.assertEqual(accounts.round_credits(247), 247.0)

    def test_model_limits_round_trip_without_disabling_other_models(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(accounts.time, 'time', return_value=1000):
            account = accounts.Account({'uid': 'limited', 'realm': 'intl', 'accessToken': 't'})
            account.save(directory)
            account.note_model_rate_limit('model-a', 1300)
            pool = accounts.AccountPool(directory)
            pool.load()
            restored = pool.get('limited')
            self.assertTrue(restored.ready())
            self.assertFalse(restored.ready_for_model('model-a'))
            self.assertTrue(restored.ready_for_model('model-b'))
            self.assertEqual(restored.public()['modelRateLimits'], {'model-a': 1300})
            pool.set_enabled('limited', False)
            pool.set_enabled('limited', True)
            self.assertFalse(restored.ready_for_model('model-a'))
            pool.add(accounts.Account({'uid': 'limited', 'realm': 'intl', 'accessToken': 'renewed'}))
            self.assertFalse(pool.get('limited').ready_for_model('model-a'))
            self.assertEqual(pool.next_model_reset('intl', 'model-a'), 1300)
            self.assertIsNone(pool.next_model_reset('cn', 'model-a'))
            self.assertIsNone(pool.pick_for_session('intl', 'chat', model='model-a'))
            self.assertEqual(pool.pick_for_session('intl', 'chat', model='model-b').uid, 'limited')

    def test_concurrent_model_limits_persist_and_shorter_deadlines_cannot_erase_longer_ones(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as directory, patch.object(accounts.time, 'time', return_value=1000):
            account = accounts.Account({'uid': 'a', 'accessToken': 't'})
            account.save(directory)
            with ThreadPoolExecutor(max_workers=4) as executor:
                list(executor.map(lambda i: account.note_model_rate_limit('m' + str(i), 2000 + i), range(20)))
            account.note_model_rate_limit('m0', 1500)
            account.clear_model_rate_limit('m0')
            restored = json.loads(Path(account.path).read_text(encoding='utf-8'))
            self.assertEqual(restored['modelRateLimits'], {'m' + str(i): 2000 + i for i in range(20)})
            self.assertNotIn('accessToken', account.public())

    def test_status_count_does_not_refresh_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(accounts.time, 'time', return_value=1000):
            pool = accounts.AccountPool(directory)
            pool.accounts = [accounts.Account({'uid': 'a', 'accessToken': 't', 'expiresAt': 900, 'refreshToken': 'refresh',
                                               'modelRateLimits': {'model-a': 1300}})]
            with patch.object(accounts.Account, 'refresh', side_effect=AssertionError('unexpected refresh')):
                self.assertEqual(pool.count_ready('intl'), 1)
                self.assertEqual(pool.count_ready('intl', 'model-a'), 0)

    def test_malformed_persisted_limits_do_not_block_accounts_forever(self):
        account = accounts.Account({'accessToken': 't', 'modelRateLimits':
            {'bool': True, 'inf': float('inf'), 'nan': float('nan'), 'text': 'later', 'negative': -1}})
        self.assertEqual(account.public()['modelRateLimits'], {})

    def test_platform_directories(self):
        for platform, os_name, expected in [
            ('win32', 'nt', os.path.join('local-data', 'CodeBuddyExtension', 'Data', 'Public', 'auth')),
            ('darwin', 'posix', os.path.join('test-home', 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')),
            ('linux', 'posix', os.path.join('xdg-config', 'CodeBuddyExtension', 'Data', 'Public', 'auth')),
        ]:
            with self.subTest(platform=platform), patch.dict(os.environ, {'LOCALAPPDATA': 'local-data', 'XDG_CONFIG_HOME': 'xdg-config'}, clear=True), patch.object(accounts.sys, 'platform', platform), patch.object(accounts.os, 'name', os_name), patch.object(accounts.os.path, 'expanduser', return_value='test-home'):
                self.assertEqual(accounts.desktop_auth_dir(), expected)

    def test_override_scans_only_recognized_credential_files(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ['workbuddy-desktop-ai.info', 'workbuddy-desktop.info', 'unrelated.info']:
                (Path(directory) / name).write_text('{}', encoding='utf-8')
            with patch.dict(os.environ, {'WORKBUDDY_DESKTOP_AUTH_DIR': directory}):
                found = accounts.desktop_credential_candidates()
            self.assertEqual(found, [(os.path.join(directory, 'workbuddy-desktop-ai.info'), 'intl'),
                                     (os.path.join(directory, 'workbuddy-desktop.info'), 'cn')])
