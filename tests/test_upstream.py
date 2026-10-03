"""Offline failover tests at the gateway's upstream connection entry point."""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.error import URLError
import ssl
import http.client
import threading
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'workbuddy-gateway'))
import wb_accounts
import wb_proxy


def upstream_error(code):
    """An APISIX-style upstream response before a model stream is established."""
    return HTTPError('https://example.invalid/v2/chat/completions', code, 'Gateway failure', {},
                     io.BytesIO(f'<html><h1>{code} Gateway failure</h1>APISIX</html>'.encode()))


class UpstreamTests(unittest.TestCase):
    def test_http_clients_receive_review_details_and_local_auth_remains_required(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), wb_proxy.Handler)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()
        try:
            with patch.object(wb_proxy, 'API_KEY', 'offline-test-key'), \
                    patch.object(wb_proxy, 'record_error'):
                for path in ('/v1/chat/completions', '/v1/responses'):
                    with self.subTest(path=path):
                        for account in self.pool.accounts:
                            account.clear_error()
                        raw = json.dumps({'code': 11140, 'displayMsg': {'zh': '内容未通过安全审核，请调整后重试。'}}).encode()
                        with patch.object(wb_proxy.urllib.request, 'urlopen',
                                          side_effect=[HTTPError('https://example.invalid', 403, 'Forbidden', {}, io.BytesIO(raw))
                                                       for _ in range(3)]) as upstream:
                            client = http.client.HTTPConnection(*server.server_address, timeout=5)
                            try:
                                client.request('POST', path, json.dumps({**self.payload, 'input': 'Hi'}),
                                               {'Authorization': 'Bearer offline-test-key', 'X-Realm': 'intl',
                                                'Content-Type': 'application/json'})
                                response = client.getresponse()
                                body = json.loads(response.read())
                            finally:
                                client.close()
                            self.assertEqual(response.status, 400)
                            self.assertEqual(body['error']['type'], 'account_restricted')
                            self.assertIn('account restricted', body['error']['message'])
                            self.assertIn('内容未通过安全审核', body['error']['message'])
                            self.assertEqual(upstream.call_count, 3)
                with patch.object(wb_proxy.urllib.request, 'urlopen') as upstream:
                    client = http.client.HTTPConnection(*server.server_address, timeout=5)
                    try:
                        client.request('POST', '/v1/chat/completions', json.dumps(self.payload),
                                       {'Authorization': 'Bearer wrong-key'})
                        response = client.getresponse()
                        self.assertEqual(response.status, 401)
                        self.assertEqual(json.loads(response.read())['error']['message'], 'invalid api key')
                    finally:
                        client.close()
                    upstream.assert_not_called()
                client = http.client.HTTPConnection(*server.server_address, timeout=5)
                try:
                    client.request('GET', '/accounts?realm=intl', headers={'Authorization': 'Bearer offline-test-key'})
                    response = client.getresponse()
                    state = json.loads(response.read())
                    self.assertEqual(state['usable'], 0)
                    self.assertTrue(all(not a['available'] for a in state['accounts']))
                finally:
                    client.close()
        finally:
            server.shutdown()
            worker.join(timeout=5)
            server.server_close()

    def test_account_restriction_rotates_and_cools_accounts_without_blame(self):
        for code in (11140, '11140'):
            with self.subTest(code=code):
                for account in self.pool.accounts:
                    account.clear_error()
                self.pool.affinity.bind('restricted', 'global-0')
                body = json.dumps({'code': code, 'msg': 'request illegal', 'displayMsg': {
                    'zh': '内容未通过安全审核，请调整后重试。',
                    'en': 'The content did not pass the safety review. Please adjust and retry.',
                }}).encode()
                with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[HTTPError('https://example.invalid', 403, 'Forbidden', {}, io.BytesIO(body)) for _ in range(3)]) as call:
                    with self.assertRaises(HTTPError) as raised:
                        wb_proxy.open_upstream(self.payload, session_key='restricted', target_realm='intl')
                self.assertEqual(raised.exception.code, 400)
                self.assertEqual(json.loads(raised.exception.read())['code'], code)
                self.assertEqual(call.call_count, 3)
                self.assertTrue(all(not a.ready() for a in self.pool.accounts[:3]))
                self.assertTrue(all('account restricted' in a.last_error for a in self.pool.accounts[:3]))
                self.assertIsNone(self.pool.affinity.get('restricted'))

    def test_ssl_failure_does_not_lock_out_next_request(self):
        failure = URLError(ssl.SSLEOFError('UNEXPECTED_EOF_WHILE_READING'))
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=failure) as call:
            with self.assertRaises(URLError):
                wb_proxy.open_upstream(self.payload, target_realm='intl')
            self.assertEqual(call.call_count, 3)
        self.assertTrue(all(a.ready() for a in self.pool.accounts))
        with patch.object(wb_proxy.urllib.request, 'urlopen', return_value=io.BytesIO()) as call:
            wb_proxy.open_upstream(self.payload, target_realm='intl')
            self.assertEqual(call.call_count, 1)

    def test_network_timeout_rotates_without_disabling_account(self):
        for failure in (TimeoutError('timed out'), ConnectionResetError('connection reset')):
            with self.subTest(failure=str(failure)):
                self.pool._cursor = 0
                with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[failure, io.BytesIO()]):
                    _, account = wb_proxy.open_upstream(self.payload, target_realm='intl')
                self.assertEqual(account.uid, 'global-1')
                self.assertTrue(self.pool.accounts[0].ready())

    def test_unknown_errors_are_not_mistaken_for_account_restriction(self):
        for body in (b'not JSON', b'[]', b'null', b'{"code":403}', b'{"msg":"request illegal"}'):
            with self.subTest(body=body):
                for a in self.pool.accounts:
                    a.clear_error()
                self.pool._cursor = 0
                error = HTTPError('https://example.invalid', 403, 'Forbidden', {}, io.BytesIO(body))
                with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[error, io.BytesIO()]) as call:
                    _, account = wb_proxy.open_upstream(self.payload, target_realm='intl')
                self.assertEqual(call.call_count, 2)
                self.assertEqual(account.uid, 'global-1')
                self.assertFalse(self.pool.accounts[0].ready())

    def test_cooling_pool_reports_and_records_503_in_both_protocols(self):
        for path in ('/v1/chat/completions', '/v1/responses'):
            with self.subTest(path=path):
                for a in self.pool.accounts:
                    a.note_error('HTTP 401')
                handler = object.__new__(wb_proxy.Handler)
                handler.path = path
                raw = json.dumps({**self.payload, 'input': 'Hi'}).encode()
                handler.headers = {'Content-Length': str(len(raw)), 'X-Realm': 'intl'}
                handler.rfile = io.BytesIO(raw)
                handler._authorized = lambda: True
                handler._error = lambda code, message, *args: (code, message)
                with patch.object(wb_proxy, 'record_error') as record, \
                        patch.object(wb_proxy.urllib.request, 'urlopen') as call:
                    status, message = handler.do_POST()
                self.assertEqual(status, 503)
                self.assertIn('no usable account', message)
                self.assertEqual(record.call_args.args[1], 503)
                call.assert_not_called()

    def test_both_protocols_report_account_restriction_and_complete_explanation(self):
        for path, payload in [('/v1/chat/completions', self.payload),
                              ('/v1/responses', {'model': 'gpt-5.5', 'input': 'Hi'})]:
            with self.subTest(path=path):
                for account in self.pool.accounts:
                    account.clear_error()
                handler = object.__new__(wb_proxy.Handler)
                handler.path = path
                raw = json.dumps(payload).encode()
                handler.headers = {'Content-Length': str(len(raw)), 'X-Realm': 'intl'}
                handler.rfile = io.BytesIO(raw)
                handler._authorized = lambda: True
                handler._error = lambda code, message, err_type='server_error': (code, message, err_type)
                reason = '内容未通过安全审核，请调整后重试。'
                body = json.dumps({'code': 11140, 'msg': 'request illegal',
                                   'padding': 'x' * 650, 'displayMsg': {'zh': reason}}).encode()
                with patch.object(wb_proxy, 'record_error') as record, \
                        patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[HTTPError('https://example.invalid', 403, 'Forbidden', {}, io.BytesIO(body)) for _ in range(3)]) as call:
                    status, message, err_type = handler.do_POST()
                self.assertEqual(status, 400)
                self.assertEqual(err_type, 'account_restricted')
                self.assertIn('account restricted', message)
                self.assertEqual(json.loads(message.split(': ', 1)[1])['displayMsg']['zh'], reason)
                self.assertNotIn('403', message)
                self.assertEqual(record.call_args.args[1], 400)
                self.assertEqual(call.call_count, 3)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.pool = wb_accounts.AccountPool(directory.name)
        self.pool.accounts = [wb_accounts.Account({
            'uid': f'global-{index}', 'realm': 'intl', 'accessToken': f'fake-{index}',
        }) for index in range(3)]
        self.pool.accounts.append(wb_accounts.Account({
            'uid': 'china-only', 'realm': 'cn', 'accessToken': 'fake-cn',
        }))
        for account in self.pool.accounts:
            account.save(directory.name)
        self.enter_patch(patch.object(wb_proxy, 'POOL', self.pool))
        self.enter_patch(patch.object(wb_proxy, 'log'))
        self.payload = {'model': 'gpt-5.5', 'messages': [{'role': 'user', 'content': 'Reply OK'}]}

    def enter_patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def test_checkin_refreshes_credits_before_returning_snapshot(self):
        account = self.pool.accounts[3]
        calls = []
        account.checkin = lambda: (calls.append('checkin') or {'ok': True, 'claimed': True})
        def fetch_credits():
            calls.append('credits')
            account.credits = {'remain': 42.5}
            return {'ok': True, 'credits': account.credits}
        account.fetch_credits = fetch_credits
        account.credits = {'remain': 42.5}
        handler = object.__new__(wb_proxy.Handler)
        handler.path = '/accounts/checkin'
        handler.headers = {'Content-Length': '2'}
        handler.rfile = io.BytesIO(b'{}')
        handler._authorized = lambda: True
        handler._json = lambda code, payload: (code, payload)

        status, payload = handler.do_POST()

        self.assertEqual(status, 200)
        self.assertEqual(calls, ['checkin', 'credits'])
        self.assertEqual(payload['results'][0]['credits']['remain'], 42.5)
        china = next(item for item in payload['accounts'] if item['uid'] == 'china-only')
        self.assertEqual(china['credits']['remain'], 42.5)

    def test_502_then_504_fail_over_to_third_global_account(self):
        self.pool.affinity.bind('conversation', 'global-0')
        success = io.BytesIO(b'data: [DONE]\n\n')
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(502), upstream_error(504), success]) as call:
            response, account = wb_proxy.open_upstream(self.payload, session_key='conversation', target_realm='intl')
        self.assertIs(response, success)
        self.assertEqual(account.uid, 'global-2')
        self.assertEqual(call.call_count, 3)
        self.assertEqual([args.args[0].get_header('Authorization') for args in call.call_args_list],
                         ['Bearer fake-0', 'Bearer fake-1', 'Bearer fake-2'])
        self.assertEqual(self.pool.affinity.get('conversation'), 'global-2')
        self.assertTrue(self.pool.accounts[0].ready())
        self.assertTrue(self.pool.accounts[1].ready())
        self.assertEqual(self.pool.accounts[3].last_error, '')

    def test_all_global_accounts_failing_returns_last_error_without_crossing_realms(self):
        last = upstream_error(504)
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(502), upstream_error(503), last]) as call:
            with self.assertRaises(HTTPError) as raised:
                wb_proxy.open_upstream(self.payload, session_key='conversation', target_realm='intl')
        self.assertEqual(raised.exception.code, last.code)
        self.assertIn(b'504 Gateway failure', raised.exception.read())
        self.assertEqual(call.call_count, 3)
        self.assertIsNone(self.pool.affinity.get('conversation'))

    def test_retry_after_region_wide_5xx_can_still_use_the_accounts(self):
        with patch.object(wb_accounts.time, 'time', return_value=10000):
            with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(502), upstream_error(504), upstream_error(502)]):
                with self.assertRaises(HTTPError):
                    wb_proxy.open_upstream(self.payload, session_key='retry', target_realm='intl')
            with patch.object(wb_accounts.time, 'time', return_value=10002):
                success = io.BytesIO(b'data: [DONE]\n\n')
                with patch.object(wb_proxy.urllib.request, 'urlopen', return_value=success) as call:
                    response, account = wb_proxy.open_upstream(self.payload, session_key='retry', target_realm='intl')
                self.assertIs(response, success)
                self.assertEqual(account.realm, 'intl')
                self.assertEqual(call.call_count, 1)

    def test_single_account_attempt_is_bounded(self):
        self.pool.accounts = self.pool.accounts[:1]
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=upstream_error(504)) as call:
            with self.assertRaises(HTTPError):
                wb_proxy.open_upstream(self.payload, target_realm='intl')
        self.assertEqual(call.call_count, 1)

        # A server outage must not make the only account unavailable to the
        # caller's next retry.
        self.assertTrue(self.pool.accounts[0].ready())

    def test_auth_rate_limit_and_gateway_errors_use_another_account(self):
        for code in (401, 403, 429, 502, 503, 504):
            with self.subTest(code=code):
                for account in self.pool.accounts:
                    account.clear_error()
                    account.model_rate_limits.clear()
                self.pool._cursor = 0
                success = io.BytesIO(b'data: [DONE]\n\n')
                with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(code), success]) as call:
                    _, account = wb_proxy.open_upstream(self.payload, target_realm='intl')
                self.assertEqual(account.uid, 'global-1')
                self.assertEqual(call.call_count, 2)
                self.assertEqual(
                    self.pool.accounts[0].ready_for_model(self.payload['model']),
                    code in (502, 503, 504),
                )
                if code in (502, 503, 504):
                    self.assertEqual(self.pool.accounts[0].last_error, '')

    def test_invalid_request_does_not_rotate_accounts(self):
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=upstream_error(400)) as call:
            with self.assertRaises(HTTPError):
                wb_proxy.open_upstream(self.payload, target_realm='intl')
        self.assertEqual(call.call_count, 1)
        self.assertTrue(all(account.ready() for account in self.pool.accounts))

    def test_all_accounts_429_only_blocks_requested_model_for_fallback_duration(self):
        with patch.object(wb_accounts.time, 'time', return_value=10000):
            with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(429) for _ in range(3)]) as call:
                with self.assertRaises(HTTPError):
                    wb_proxy.open_upstream(self.payload, target_realm='intl')
            self.assertEqual(call.call_count, 3)
            self.assertFalse(any(
                account.ready_for_model(self.payload['model'])
                for account in self.pool.accounts[:3]
            ))
            with patch.object(wb_accounts.time, 'time', return_value=10031):
                self.assertFalse(any(
                    account.ready_for_model(self.payload['model'])
                    for account in self.pool.accounts[:3]
                ))
            with patch.object(wb_accounts.time, 'time', return_value=10301):
                self.assertTrue(all(
                    account.ready_for_model(self.payload['model'])
                    for account in self.pool.accounts[:3]
                ))
            # The unrelated realm is never touched.
            self.assertTrue(self.pool.accounts[3].ready())

    def test_partial_429_keeps_model_fallback_deadline(self):
        success = io.BytesIO(b'data: [DONE]\n\n')
        with patch.object(wb_accounts.time, 'time', return_value=10000):
            with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[upstream_error(429), success]):
                wb_proxy.open_upstream(self.payload, target_realm='intl')
            with patch.object(wb_accounts.time, 'time', return_value=10031):
                self.assertFalse(self.pool.accounts[0].ready_for_model(self.payload['model']))
            with patch.object(wb_accounts.time, 'time', return_value=10301):
                self.assertTrue(self.pool.accounts[0].ready_for_model(self.payload['model']))

    def test_authentication_cooldown_is_not_bypassed(self):
        for account in self.pool.accounts:
            account.note_error('HTTP 401', cooldown=300)
        with patch.object(wb_proxy.urllib.request, 'urlopen') as call:
            with self.assertRaisesRegex(RuntimeError, 'no usable account'):
                wb_proxy.open_upstream(self.payload, target_realm='intl')
        call.assert_not_called()

    def test_distinct_resets_survive_restart_and_other_models_still_work(self):
        now = 1789624800  # 2026-09-17 14:00:00 UTC+8
        deadlines = [now + 10276, now + 867, now + 1310]
        errors = []
        for stamp in ['16:51:16', '14:14:27', '14:21:50']:
            raw = json.dumps({'code': 6004, 'msg':
                f'usage exceeds frequency limit, your usage will reset at 2026-09-17 {stamp} UTC+8'}).encode()
            errors.append(HTTPError('https://example.invalid', 429, 'rate limit', {}, io.BytesIO(raw)))
        with patch.object(wb_accounts.time, 'time', return_value=now):
            with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=errors) as call:
                with self.assertRaises(HTTPError) as raised:
                    wb_proxy.open_upstream(self.payload, session_key='conversation', target_realm='intl')
            self.assertEqual(call.call_count, 3)
            self.assertEqual([c.args[0].get_header('Authorization') for c in call.call_args_list],
                             ['Bearer fake-0', 'Bearer fake-1', 'Bearer fake-2'])
            self.assertEqual(json.loads(raised.exception.read())['code'], 6004)
            self.assertIsNone(self.pool.affinity.get('conversation'))
            restarted = wb_accounts.AccountPool(self.pool.dir)
            restarted.load()
            for index, deadline in enumerate(deadlines):
                account = restarted.get(f'global-{index}')
                self.assertEqual(account.model_reset_at(self.payload['model']), deadline)
                self.assertTrue(account.ready())
                self.assertTrue(account.ready_for_model('different-model'))
            with patch.object(wb_proxy, 'POOL', restarted), patch.object(wb_proxy.urllib.request, 'urlopen') as call:
                with self.assertRaises(HTTPError) as raised:
                    wb_proxy.open_upstream(self.payload, target_realm='intl')
                self.assertEqual(raised.exception.code, 429)
                self.assertEqual(json.loads(raised.exception.read())['resetAt'], min(deadlines))
                call.assert_not_called()
                wb_proxy.open_upstream({**self.payload, 'model': 'different-model'}, target_realm='intl')
                self.assertEqual(call.call_count, 1)
        with patch.object(wb_accounts.time, 'time', return_value=min(deadlines) + 1), \
                patch.object(wb_proxy, 'POOL', restarted), \
                patch.object(wb_proxy.urllib.request, 'urlopen', return_value=io.BytesIO()) as call:
            _, selected = wb_proxy.open_upstream(self.payload, target_realm='intl')
            self.assertEqual(selected.uid, 'global-1')
            self.assertEqual(call.call_count, 1)

    def test_http_400_with_6004_switches_but_other_400_does_not(self):
        raw = json.dumps({'code': 6004, 'msg': 'frequency limit'}).encode()
        error = HTTPError('https://example.invalid', 400, 'bad request', {}, io.BytesIO(raw))
        with patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=[error, io.BytesIO()]) as call:
            _, account = wb_proxy.open_upstream(self.payload, target_realm='intl')
        self.assertEqual(account.uid, 'global-1')
        self.assertEqual(call.call_count, 2)
        self.assertTrue(self.pool.accounts[0].ready())

    def test_successful_connection_does_not_read_or_replay_stream(self):
        response = io.BytesIO(b'data: hello\n\n')
        with patch.object(wb_proxy.urllib.request, 'urlopen', return_value=response) as call:
            upstream, account = wb_proxy.open_upstream(self.payload, target_realm='intl')
        self.assertEqual(call.call_count, 1)
        self.assertEqual(upstream.tell(), 0)
        self.assertEqual(account.uid, 'global-0')

    def test_both_http_protocols_preserve_rate_limit_body_and_cached_429(self):
        for path, payload in [('/v1/chat/completions', self.payload),
                              ('/v1/responses', {'model': 'gpt-5.5', 'input': 'Hi'})]:
            with self.subTest(path=path), patch.object(wb_accounts.time, 'time', return_value=10000):
                self.pool.accounts = [wb_accounts.Account({
                    'uid': 'global-0', 'realm': 'intl', 'accessToken': 'fake-0',
                })]
                self.pool.accounts[0].save(self.pool.dir)
                handler = object.__new__(wb_proxy.Handler)
                handler.path = path
                raw = json.dumps(payload).encode()
                handler.headers = {'Content-Length': str(len(raw)), 'X-Realm': 'intl'}
                handler.rfile = io.BytesIO(raw)
                handler._authorized = lambda: True
                handler._error = lambda code, message, *args: (code, message)
                body = b'{"code":6004,"msg":"frequency limited","requestId":"test-id"}'
                error = HTTPError('https://example.invalid', 429, 'limited', {}, io.BytesIO(body))
                with patch.object(wb_proxy, 'record_error'), \
                        patch.object(wb_proxy.urllib.request, 'urlopen', side_effect=error) as call:
                    status, message = handler.do_POST()
                    self.assertEqual(status, 429)
                    self.assertIn('test-id', message)
                    handler.rfile = io.BytesIO(raw)
                    status, message = handler.do_POST()
                    self.assertEqual(status, 429)
                    self.assertIn('resetAt', message)
                    self.assertEqual(call.call_count, 1)
