"""Offline startup check-in with real account persistence and mocked upstream I/O."""

import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
from wb_accounts import Account
from wb_scheduler import Scheduler


class SchedulerTests(unittest.TestCase):
    def mock(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def setUp(self):
        self.mock(patch('wb_scheduler.do_cat_travel', return_value={}))
        self.mock(patch('wb_scheduler.time.sleep'))
        self.credits = self.mock(patch.object(Account, 'fetch_credits', return_value={'ok': True}))
        self.upstream = self.mock(patch('wb_accounts.http_json', return_value={'code': 0}))

    def account(self, **fields):
        return Account({'uid': 'offline', 'realm': 'cn', 'accessToken': 'fake', **fields})

    def run_cycle(self, *accounts):
        scheduler = Scheduler(SimpleNamespace(accounts=list(accounts)))
        scheduler._execute_cycle('startup')
        return scheduler

    def test_startup_checks_in_and_refreshes_credits(self):
        account = self.account()
        self.run_cycle(account)
        self.assertTrue(account.checkin_claimed_today())
        self.upstream.assert_called_once()
        self.credits.assert_called_once()

    def test_restart_skips_persisted_success_and_next_day_checks_in(self):
        with tempfile.TemporaryDirectory() as directory:
            account = self.account()
            account.save(directory)
            self.run_cycle(account)
            restored = Account(json.loads(Path(account.path).read_text(encoding='utf-8')))
            self.run_cycle(restored)
            self.assertEqual(self.upstream.call_count, 1)
            restored.last_checkin = '2000-01-01 12:00:00'
            self.run_cycle(restored)
            self.assertEqual(self.upstream.call_count, 2)

    def test_disabled_and_international_accounts_do_not_check_in(self):
        self.run_cycle(self.account(enabled=False), self.account(realm='intl'))
        self.upstream.assert_not_called()
        self.credits.assert_not_called()

    def test_failure_can_retry_on_next_startup(self):
        account = self.account()
        self.upstream.side_effect = [OSError('offline'), {'code': 0}]
        self.run_cycle(account)
        self.assertFalse(account.checkin_claimed_today())
        self.run_cycle(account)
        self.assertTrue(account.checkin_claimed_today())
        self.credits.assert_called_once()

    def test_credit_refresh_failure_does_not_skip_other_accounts(self):
        first, second = self.account(uid='first'), self.account(uid='second')
        self.credits.side_effect = [OSError('offline'), {'ok': True}]
        self.run_cycle(first, second)
        self.assertTrue(first.checkin_claimed_today())
        self.assertTrue(second.checkin_claimed_today())

    def test_overlapping_cycles_do_not_duplicate_checkin(self):
        account = self.account()
        scheduler = Scheduler(SimpleNamespace(accounts=[account]))

        def upstream(*args, **kwargs):
            scheduler._execute_cycle('overlapping manual trigger')
            return {'code': 0}

        self.upstream.side_effect = upstream
        scheduler._execute_cycle('startup')
        self.upstream.assert_called_once()

    def test_stopped_startup_does_not_check_in(self):
        scheduler = Scheduler(SimpleNamespace(accounts=[self.account()]))
        scheduler.stop()
        scheduler._run_loop()
        self.upstream.assert_not_called()

    def test_background_startup_runs_checkin_after_initial_wait(self):
        account = self.account()
        scheduler = Scheduler(SimpleNamespace(accounts=[account]))
        cycle = scheduler._execute_cycle

        def startup(reason):
            cycle(reason)
            scheduler.stop()

        with patch.object(scheduler._stop_event, 'wait', return_value=False) as wait, \
                patch.object(scheduler, '_execute_cycle', side_effect=startup):
            scheduler._run_loop()
        wait.assert_called_once_with(10)
        self.assertTrue(account.checkin_claimed_today())

    def test_travel_failure_does_not_skip_next_accounts_checkin(self):
        first, second = self.account(uid='first'), self.account(uid='second')
        with patch('wb_scheduler.do_cat_travel', side_effect=OSError('offline')):
            self.run_cycle(first, second)
        self.assertTrue(first.checkin_claimed_today())
        self.assertTrue(second.checkin_claimed_today())
