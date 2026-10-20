"""Offline daily activity confirmation, restart admission and failure containment."""
from datetime import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
import wb_growth as growth
from wb_accounts import Account, AccountPool
from wb_scheduler import Scheduler


DAY = '2026-10-17'
NOW = datetime(2026, 10, 17, 10, tzinfo=growth.SHANGHAI).timestamp()


def heatmap(active, day=DAY):
    return {'today': {'date': day, 'is_active': active}}


class GrowthTests(unittest.TestCase):
    def setUp(self):
        self.clock = patch('wb_growth.time.time', return_value=NOW).start()
        self.addCleanup(patch.stopall)
        self.stop = threading.Event()
        self.runner = growth.GrowthCheckin(True, 300, 3)
        self.account = Account({'uid': 'offline', 'realm': 'cn', 'accessToken': 'fake'})
        self.request = patch('wb_growth.request').start()

    def run_once(self):
        return self.runner.run(self.account, self.stop)

    def reports(self):
        return [call for call in self.request.call_args_list if call.args[1] == '/v2/report']

    def test_report_is_confirmed_only_by_official_today_activity(self):
        self.request.side_effect = [heatmap(False), None, heatmap(True)]
        result = self.run_once()
        self.assertEqual(result['status'], 'confirmed')
        self.assertEqual(len(self.reports()), 1)
        event = self.reports()[0].args[2][0]
        self.assertEqual(event['eventCode'], 'chat_request_send')
        self.assertEqual(event['userId'], 'offline')
        self.assertEqual(self.account.public()['growthCheckin']['status'], 'confirmed')
        self.assertIsNone(self.account.last_checkin)

    def test_already_active_never_reports_and_next_day_is_independent(self):
        self.request.return_value = heatmap(True)
        self.run_once()
        self.assertIsNone(self.run_once())
        self.assertEqual(self.request.call_count, 1)
        self.assertFalse(self.reports())
        self.clock.return_value += 86400
        self.assertEqual(self.account.public()['growthCheckin']['status'], 'not_started')
        self.request.return_value = heatmap(True, '2026-10-18')
        self.assertEqual(self.run_once()['status'], 'confirmed')
        self.assertEqual(self.request.call_count, 2)

    def test_pending_survives_restart_and_checks_do_not_resend(self):
        with tempfile.TemporaryDirectory() as directory:
            self.account.save(directory)
            self.request.side_effect = [heatmap(False), None, heatmap(False)]
            self.assertEqual(self.run_once()['status'], 'pending')
            self.account = Account(json.loads(Path(self.account.path).read_text()), self.account.path)
            self.assertIsNone(self.run_once())
            self.clock.return_value += 301
            self.request.side_effect = [heatmap(True)]
            self.assertEqual(self.run_once()['status'], 'confirmed')
            self.assertEqual(len(self.reports()), 1)
            restored = Account(json.loads(Path(self.account.path).read_text()))
            self.assertEqual(restored.public()['growthCheckin']['status'], 'confirmed')

    def test_report_timeout_is_admitted_before_io_and_never_resent(self):
        with tempfile.TemporaryDirectory() as directory:
            self.account.save(directory)
            def request(account, path, body=None):
                if body is not None:
                    saved = json.loads(Path(account.path).read_text())['growthCheckin']
                    self.assertTrue(saved['reported'])
                    raise growth.GrowthError('request_failed')
                return heatmap(False)
            self.request.side_effect = request
            self.assertEqual(self.run_once()['reason'], 'request_failed')
            self.account = Account(json.loads(Path(self.account.path).read_text()), self.account.path)
            self.clock.return_value += 301
            self.run_once()
            self.assertEqual(len(self.reports()), 1)

    def test_retry_budget_survives_restarts_and_never_fakes_success(self):
        self.request.side_effect = lambda _a, path, *args: heatmap(False) if path.endswith('heatmap') else None
        for _ in range(3):
            result = self.run_once()
            self.account = Account(self.account.to_dict())
            self.clock.return_value += 301
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'not_recorded')
        self.assertIsNone(self.run_once())
        self.assertEqual(len(self.reports()), 1)
        self.assertEqual(self.request.call_count, 5)

    def test_failed_precheck_can_retry_without_spending_report_admission(self):
        self.request.side_effect = growth.GrowthError('request_failed')
        self.assertEqual(self.run_once()['status'], 'pending')
        self.assertFalse(self.account.growth_checkin['reported'])
        self.clock.return_value += 301
        self.request.side_effect = [heatmap(False), None, heatmap(True)]
        self.assertEqual(self.run_once()['status'], 'confirmed')
        self.assertEqual(len(self.reports()), 1)

    def test_untrusted_today_fields_do_not_admit_activity(self):
        for data in [None, {}, {'today': True}, heatmap(True, '2026-10-16'),
                     heatmap('true'), {'today': {'date': DAY, 'score': 5}},
                     {'today': {'date': DAY, 'is_active': 1}}]:
            with self.subTest(data=data):
                self.account.growth_checkin = None
                self.request.return_value = data
                self.assertEqual(self.run_once()['reason'], 'invalid_response')
                self.assertFalse(self.account.growth_checkin['reported'])
        self.assertFalse(self.reports())

    def test_ineligible_accounts_disabled_automation_and_shutdown_do_no_io(self):
        for override in [{'enabled': False}, {'realm': 'intl'}, {'enterpriseId': 'team'}, {'accessToken': ''}]:
            self.account = Account({'realm': 'cn', 'accessToken': 'fake', **override})
            self.assertIsNone(self.run_once())
        self.account = Account({'realm': 'cn', 'accessToken': 'fake'})
        self.runner.enabled = False
        self.assertIsNone(self.run_once())
        self.runner.enabled = True
        self.stop.set()
        self.assertIsNone(self.run_once())
        self.request.assert_not_called()

    def test_disabling_during_precheck_prevents_report(self):
        def precheck(*args):
            self.runner.enabled = False
            return heatmap(False)
        self.request.side_effect = precheck
        self.run_once()
        self.assertFalse(self.reports())

    def test_shutdown_after_report_preserves_admission_without_next_request(self):
        def request(_account, path, *args):
            if path.endswith('report'):
                self.stop.set()
                return None
            return heatmap(False)
        self.request.side_effect = request
        self.assertEqual(self.run_once()['status'], 'pending')
        self.assertTrue(self.account.growth_checkin['reported'])
        self.assertEqual(self.request.call_count, 2)

    def test_storage_failure_prevents_outbound_requests(self):
        self.account.path = '/offline/account.json'
        with patch.object(self.account, 'save', side_effect=OSError('disk full')):
            self.assertEqual(self.run_once()['reason'], 'storage_failed')
        self.request.assert_not_called()

    def test_restart_after_interrupted_final_check_exposes_exhausted_budget(self):
        self.account.growth_checkin = {**growth.new_state(DAY), 'checks': 3, 'reported': True,
                                      'status': 'pending', 'reason': 'not_recorded'}
        self.assertEqual(self.run_once()['status'], 'failed')
        self.assertIsNone(self.run_once())
        self.request.assert_not_called()

    def test_expired_credentials_refresh_before_growth_query(self):
        self.account.expires_at = NOW - 1
        with patch.object(self.account, 'refresh', return_value=False) as refresh:
            self.assertEqual(self.run_once()['reason'], 'auth_required')
            refresh.assert_called_once()
        self.request.assert_not_called()

    def test_stop_during_admission_save_prevents_post(self):
        self.account.path = '/offline/account.json'
        def save(_directory):
            if self.account.growth_checkin['reported']:
                self.stop.set()
        with patch.object(self.account, 'save', side_effect=save):
            self.request.return_value = heatmap(False)
            self.run_once()
        self.assertFalse(self.reports())

    def test_invalid_persistence_is_visible_without_resetting_admission(self):
        for value in [[], {}, {**growth.new_state(DAY), 'reason': []},
                      {**growth.new_state(DAY), 'nextCheckAt': float('nan')}]:
            self.account.growth_checkin = value
            self.assertIsNone(self.run_once())
            self.assertEqual(self.account.public()['growthCheckin']['reason'], 'invalid_state')
        self.request.assert_not_called()

    def test_reimport_preserves_daily_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            pool = AccountPool(directory)
            self.account.growth_checkin = {**growth.new_state(DAY), 'reported': True, 'status': 'pending'}
            pool.add(self.account)
            replacement = Account({'uid': 'offline', 'realm': 'cn', 'accessToken': 'replacement'})
            pool.add(replacement)
            self.assertTrue(replacement.growth_checkin['reported'])
            stored = json.loads(Path(replacement.path).read_text())
            self.assertTrue(stored['growthCheckin']['reported'])

    def test_growth_poll_shares_scheduler_lock_and_does_not_run_other_tasks(self):
        scheduler = Scheduler(SimpleNamespace(accounts=[self.account]))
        scheduler.growth = self.runner
        def request(_account, path, *args):
            scheduler._execute_growth()
            return heatmap(False) if path.endswith('heatmap') else None
        self.request.side_effect = request
        with patch.object(self.account, 'checkin') as billing, patch('wb_scheduler.do_cat_travel') as travel:
            scheduler._execute_growth()
            billing.assert_not_called()
            travel.assert_not_called()
        self.assertEqual(len(self.reports()), 1)

    def test_shanghai_midnight_does_not_depend_on_host_timezone(self):
        self.clock.return_value = datetime.fromisoformat('2026-10-17T15:59:59+00:00').timestamp()
        self.assertEqual(growth.today(), '2026-10-17')
        self.clock.return_value += 1
        self.assertEqual(growth.today(), '2026-10-18')


class GrowthTransportTests(unittest.TestCase):
    def test_report_uses_chat_host_and_sends_no_duplicate_on_timeout(self):
        account = Account({'uid': 'offline', 'realm': 'cn', 'accessToken': 'fake'})
        with patch('wb_growth.urllib.request.urlopen', side_effect=TimeoutError) as opening:
            with self.assertRaisesRegex(growth.GrowthError, 'request_failed'):
                growth.request(account, '/v2/report', [{'eventCode': 'chat_request_send'}])
        opening.assert_called_once()
        req = opening.call_args.args[0]
        self.assertEqual(req.full_url, 'https://copilot.tencent.com/v2/report')
        self.assertEqual(req.method, 'POST')
        self.assertEqual(req.get_header('Authorization'), 'Bearer fake')

    def test_nonzero_or_malformed_business_response_is_not_success(self):
        for payload in [[], {}, {'code': False}, {'code': '0'}, {'code': 123}]:
            with self.subTest(payload=payload), patch('wb_growth.urllib.request.urlopen',
                    return_value=io.BytesIO(json.dumps(payload).encode())):
                with self.assertRaises(growth.GrowthError):
                    growth.request(Account({'realm': 'cn'}), '/activity/growth/heatmap')

    def test_auth_error_has_safe_actionable_reason(self):
        error = HTTPError('https://copilot.tencent.com', 401, 'no', {}, io.BytesIO(b'private'))
        with patch('wb_growth.urllib.request.urlopen', side_effect=error):
            with self.assertRaisesRegex(growth.GrowthError, '^auth_required$'):
                growth.request(Account({'realm': 'cn'}), '/activity/growth/heatmap')
