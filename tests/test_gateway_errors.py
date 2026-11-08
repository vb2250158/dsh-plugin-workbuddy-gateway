"""Synthetic error regressions with isolated source and real-handler coverage."""

import ast
import builtins
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
import urllib.error
import urllib.request


VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "workbuddy-gateway"
SPEC = importlib.util.spec_from_file_location("gateway_errors_under_test", VENDOR / "wb_errors.py")
wb_errors = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wb_errors)


def handler_from_source():
    """Load the actual error methods only, with runtime dependencies replaced."""
    source = ast.parse((VENDOR / "wb_proxy.py").read_text(encoding="utf-8"))
    handler = next(node for node in source.body if isinstance(node, ast.ClassDef)
                   and node.name == "Handler")
    selected = ast.ClassDef(
        name="Handler", bases=[], keywords=[], decorator_list=[],
        body=[node for node in handler.body if isinstance(node, ast.FunctionDef)
              and node.name in ("_error", "_upstream_error")],
    )
    record = Mock()
    namespace = {
        "json": json,
        "time": types.SimpleNamespace(time=lambda: 100),
        "record_error": record,
        "ACCOUNT_RESTRICTION_CODE": 11140,
        "channel_rejection_error": wb_errors.channel_rejection_error,
    }
    module = ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[]))
    exec(compile(module, str(VENDOR / "wb_proxy.py"), "exec"), namespace)
    return namespace["Handler"](), record


def upstream_from_source():
    """Load the actual connection function with synthetic accounts and no transport."""
    source = ast.parse((VENDOR / "wb_proxy.py").read_text(encoding="utf-8"))
    selected = [node for node in source.body if isinstance(node, ast.FunctionDef)
                and node.name in ("open_upstream", "is_account_restriction")]
    rate_source = ast.parse((VENDOR / "wb_rate_limits.py").read_text(encoding="utf-8"))
    selected.extend(node for node in rate_source.body if isinstance(node, ast.FunctionDef)
                    and node.name in ("_payload", "is_model_rate_limit"))
    accounts = [types.SimpleNamespace(
        uid="synthetic-%s" % index, realm="intl", headers=Mock(return_value={}),
        note_error=Mock(), note_model_rate_limit=Mock(), clear_error=Mock(),
        clear_model_rate_limit=Mock(),
    ) for index in range(3)]
    pool = types.SimpleNamespace(count_ready=Mock(return_value=3),
                                 pick_for_session=Mock(side_effect=accounts), affinity=Mock())
    transport = Mock()
    namespace = {
        "json": json, "io": io, "time": time,
        "urllib": types.SimpleNamespace(error=urllib.error, request=types.SimpleNamespace(
            Request=urllib.request.Request, urlopen=transport)),
        "CURRENT_REALM": "intl", "CHAT_PATH": "/v2/chat/completions", "POOL": pool,
        "ACCOUNT_RESTRICTION_CODE": 11140, "ACCOUNT_RESTRICTION_COOLDOWN_SECONDS": 3600,
        "RATE_LIMIT_FALLBACK_SECONDS": 300, "rate_limit_reset": Mock(return_value=200),
        "build_upstream_body": lambda payload: payload,
        "is_channel_rejection_body": wb_errors.is_channel_rejection_body,
        "wb_accounts": types.SimpleNamespace(get_realm_config=lambda realm: {
            "chat_upstream": "https://example.invalid"}),
        "log": Mock(),
    }
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, str(VENDOR / "wb_proxy.py"), "exec"), namespace)
    return namespace["open_upstream"], pool, accounts, transport


class ChannelRejectionTests(unittest.TestCase):
    def test_numeric_and_string_codes_have_stable_nonretryable_fields(self):
        for code in (11128, "11128"):
            with self.subTest(code=code):
                result = wb_errors.channel_rejection_error({"code": code}, 400)
                self.assertEqual(result["type"], "channel_rejected")
                self.assertEqual(result["code"], 400)
                self.assertEqual(result["upstream_code"], 11128)
                self.assertIs(result["retryable"], False)
                self.assertIn("channel is not approved", result["message"])
                self.assertIn("WorkBuddy support", result["message"])

    def test_explicit_code_is_required(self):
        cases = (None, [], "11128", {"code": 11128.0}, {"code": True},
                 {"code": " 11128"}, {"code": "11128 "}, {"code": 11140},
                 {"code": 6004}, {"msg": "Illegal API invocation from an unapproved channel"},
                 {"error": {"code": 11128}})
        for data in cases:
            with self.subTest(data=data):
                self.assertIsNone(wb_errors.channel_rejection_error(data, 400))

    def test_raw_body_detection_rejects_unstructured_or_ambiguous_errors(self):
        for code in (11128, "11128"):
            self.assertTrue(wb_errors.is_channel_rejection_body(json.dumps({"code": code}).encode()))
        for raw in (b"not JSON", b"\xff", b"[]", b"null", b'"11128"', b'{"code":11128.0}',
                    b'{"error":{"code":11128}}', b'{"code":11140}', b'{"code":6004}'):
            with self.subTest(raw=raw):
                self.assertFalse(wb_errors.is_channel_rejection_body(raw))

    def test_only_bounded_ascii_request_ids_are_exposed(self):
        for request_id in ("trace-123:abc.def_0", "a" * 128):
            with self.subTest(request_id=request_id):
                result = wb_errors.channel_rejection_error({"code": 11128, "requestId": request_id}, 400)
                self.assertEqual(result["requestId"], request_id)
        for request_id in (None, 123, [], {}, "", "a" * 129, "line\nbreak", "trace id",
                           "token=secret", "<html>", "追踪123", "trailing\n"):
            with self.subTest(request_id=request_id):
                result = wb_errors.channel_rejection_error({"code": 11128, "requestId": request_id}, 400)
                self.assertNotIn("requestId", result)

    def test_upstream_message_and_policy_cannot_override_safe_fields(self):
        data = {"code": 11128, "msg": "SYNTHETIC_PRIVATE_MARKER", "accessToken": "synthetic-secret",
                "displayMsg": {"en": "pretend success"}, "retry_policy": {"retry": True},
                "type": "success", "retryable": True, "requestId": "safe-123"}
        before = json.dumps(data, sort_keys=True)
        result = wb_errors.channel_rejection_error(data, 400)
        self.assertIs(result["retryable"], False)
        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", json.dumps(result))
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertNotIn("retry_policy", result)
        self.assertEqual(before, json.dumps(data, sort_keys=True))


class UpstreamTerminalErrorTests(unittest.TestCase):
    def test_400_and_403_channel_refusals_stop_without_account_changes(self):
        for status in (400, 403):
            for code in (11128, "11128"):
                with self.subTest(status=status, code=code):
                    open_upstream, pool, accounts, transport = upstream_from_source()
                    raw = json.dumps({"code": code, "msg": "synthetic channel rejection",
                                      "retry_policy": {"retry": False}}).encode()
                    transport.side_effect = HTTPError("https://example.invalid", status, "synthetic", {}, io.BytesIO(raw))
                    with self.assertRaises(HTTPError) as raised:
                        open_upstream({"model": "synthetic-model", "messages": []},
                                      session_key="synthetic-session", target_realm="intl")
                    self.assertEqual(raised.exception.code, status)
                    with raised.exception:
                        self.assertEqual(raised.exception.read(), raw)
                    self.assertEqual(transport.call_count, 1)
                    self.assertEqual(pool.pick_for_session.call_count, 1)
                    pool.affinity.unbind.assert_not_called()
                    for account in accounts:
                        account.note_error.assert_not_called()
                        account.note_model_rate_limit.assert_not_called()
                        account.clear_error.assert_not_called()
                        account.clear_model_rate_limit.assert_not_called()

    def test_other_403_and_11140_and_6004_keep_existing_rotation(self):
        for status, code, penalty in ((403, 11101, "account"),
                                      (403, 11140, "restriction"),
                                      (400, 6004, "model")):
            with self.subTest(status=status, code=code):
                open_upstream, pool, accounts, transport = upstream_from_source()
                raw = json.dumps({"code": code}).encode()
                success = io.BytesIO(b"synthetic stream")
                transport.side_effect = [HTTPError("https://example.invalid", status, "synthetic", {}, io.BytesIO(raw)), success]
                response, selected = open_upstream({"model": "synthetic-model", "messages": []},
                                                   session_key="synthetic-session", target_realm="intl")
                self.assertIs(response, success)
                self.assertIs(selected, accounts[1])
                self.assertEqual(transport.call_count, 2)
                self.assertEqual(pool.pick_for_session.call_count, 2)
                pool.affinity.unbind.assert_called_once_with("synthetic-session")
                if penalty == "model":
                    accounts[0].note_error.assert_not_called()
                    accounts[0].note_model_rate_limit.assert_called_once_with("synthetic-model", 200)
                else:
                    accounts[0].note_error.assert_called_once()
                    accounts[0].note_model_rate_limit.assert_not_called()
                    self.assertEqual(accounts[0].note_error.call_args.kwargs["cooldown"],
                                     3600 if penalty == "restriction" else 60)


class HandlerErrorTests(unittest.TestCase):
    def response(self, status, data):
        handler, record = handler_from_source()
        captured = []
        handler._json = lambda code, body: captured.append((code, body))
        raw = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
        error = HTTPError("https://example.invalid", status, "synthetic", {}, io.BytesIO(raw))
        handler._upstream_error(error, "synthetic-model", 99)
        self.assertEqual(len(captured), 1)
        self.assertTrue(error.closed)
        return captured[0], record

    def test_11128_output_keeps_http400_and_drops_raw_json_from_user_message(self):
        data = {"code": 11128, "msg": "SYNTHETIC_PRIVATE_MARKER",
                "retry_policy": {"retry": False}, "requestId": "trace-123"}
        (status, body), record = self.response(400, data)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], 400)
        self.assertEqual(body["error"]["type"], "channel_rejected")
        self.assertEqual(body["error"]["upstream_code"], 11128)
        self.assertIs(body["error"]["retryable"], False)
        self.assertEqual(body["error"]["requestId"], "trace-123")
        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", body["error"]["message"])
        self.assertNotIn("retry_policy", body["error"]["message"])
        self.assertEqual(record.call_args.args[:2], ("synthetic-model", 400))
        self.assertEqual(json.loads(record.call_args.args[2]), data)
        self.assertEqual(record.call_args.kwargs["elapsed_ms"], 1000)

    def test_string_11128_is_classified_and_original_status_is_preserved(self):
        for status in (400, 403):
            with self.subTest(status=status):
                (returned_status, body), _ = self.response(status, {"code": "11128"})
                self.assertEqual(returned_status, status)
                self.assertEqual(body["error"]["code"], status)
                self.assertEqual(body["error"]["type"], "channel_rejected")

    def test_account_restriction_semantics_are_unchanged(self):
        data = {"code": 11140, "displayMsg": {"zh": "synthetic restriction"}}
        (status, body), _ = self.response(400, data)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["type"], "account_restricted")
        self.assertEqual(body["error"]["code"], 400)
        self.assertTrue(body["error"]["message"].startswith("WorkBuddy account restricted by upstream (code 11140): "))
        self.assertEqual(json.loads(body["error"]["message"].split(": ", 1)[1]), data)
        self.assertNotIn("upstream_code", body["error"])

    def test_rate_limit_and_other_json_errors_are_unchanged(self):
        for status, data, error_type in ((429, {"code": 6004, "msg": "synthetic limit"}, "server_error"),
                                         (400, {"code": 11101, "msg": "synthetic invalid"}, "invalid_request_error")):
            with self.subTest(status=status):
                (returned_status, body), _ = self.response(status, data)
                self.assertEqual(returned_status, status)
                self.assertEqual(body, {"error": {"message": "upstream %s: %s" % (status, json.dumps(data, ensure_ascii=False)),
                                                  "type": error_type, "code": status}})

    def test_nonjson_and_nondictionary_errors_are_unchanged(self):
        for raw in (b"synthetic plain text", b"<html>synthetic</html>", b"[]", b"null"):
            with self.subTest(raw=raw):
                (status, body), _ = self.response(502, raw)
                self.assertEqual(status, 502)
                self.assertEqual(body["error"], {"message": "upstream 502: " + raw.decode(),
                                                "type": "server_error", "code": 502})


class RealHandlerIntegrationTests(unittest.TestCase):
    def test_both_protocols_stop_11128_with_real_import_and_http_serialization(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            usage = Path(directory) / "usage"
            stack.enter_context(patch.dict(os.environ, {
                "WB_PROXY_USAGE_DIR": str(usage), "LOCALAPPDATA": directory,
                "HOME": directory, "USERPROFILE": directory,
                "WB_PROXY_DEFAULT_REALM": "intl",
            }))
            stack.enter_context(patch.object(sys, "path", [str(VENDOR), *sys.path]))
            stack.enter_context(patch.dict(sys.modules))
            denied = AssertionError("Real network access is forbidden in gateway error tests")
            transport = stack.enter_context(patch("urllib.request.urlopen", side_effect=denied))
            no_connection = stack.enter_context(patch("socket.create_connection", side_effect=denied))
            no_connect = stack.enter_context(patch.object(socket.socket, "connect", side_effect=denied))
            no_connect_ex = stack.enter_context(patch.object(socket.socket, "connect_ex", side_effect=denied))
            original_open, original_io_open = builtins.open, io.open
            isolated_root = Path(directory).resolve()
            source_root = VENDOR.resolve()

            def isolated_open(delegate):
                """Allow fixture data and Python sources, reject real runtime files."""
                def open_file(file, mode="r", *args, **kwargs):
                    target = Path(file).resolve()
                    fixture_file = target.is_relative_to(isolated_root)
                    source_file = (target.is_relative_to(source_root) and target.suffix == ".py"
                                   and not any(flag in mode for flag in "wax+"))
                    if not (fixture_file or source_file):
                        raise AssertionError("Real account, cache, and configuration access is forbidden")
                    return delegate(file, mode, *args, **kwargs)
                return open_file

            stack.enter_context(patch("builtins.open", isolated_open(original_open)))
            stack.enter_context(patch("io.open", isolated_open(original_io_open)))
            spec = importlib.util.spec_from_file_location("wb_proxy_real_handler_test", VENDOR / "wb_proxy.py")
            proxy = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(proxy)
            transport.assert_not_called()
            self.assertEqual(Path(proxy.USAGE_DIR), usage)
            self.assertIsNone(proxy.POOL)
            stack.enter_context(patch.object(proxy.wb_accounts, "AccountPool", side_effect=AssertionError("Real account store access is forbidden")))
            stack.enter_context(patch.object(proxy.wb_accounts.Account, "headers", side_effect=AssertionError("Real account headers are forbidden")))
            stack.enter_context(patch.object(proxy, "ACCOUNTS_DIR", str(Path(directory) / "accounts")))
            stack.enter_context(patch.object(proxy, "PRODUCT_CONFIG_CACHE", str(Path(directory) / "absent-config.json")))
            stack.enter_context(patch.object(proxy, "AUTH_DIRS", []))
            stack.enter_context(patch.object(proxy, "API_KEY", "synthetic-local-key"))
            stack.enter_context(patch.object(proxy, "log"))
            expected_rows = 0
            for route in ("/v1/chat/completions", "/v1/responses"):
                for upstream_status in (400, 403):
                    with self.subTest(route=route, upstream_status=upstream_status):
                        accounts = [types.SimpleNamespace(
                            uid="synthetic-%s" % index, realm="intl",
                            headers=Mock(return_value={"Content-Type": "application/json"}),
                            note_error=Mock(), note_model_rate_limit=Mock(), clear_error=Mock(),
                            clear_model_rate_limit=Mock(),
                        ) for index in range(3)]
                        pool = types.SimpleNamespace(count_ready=Mock(return_value=3),
                                                     pick_for_session=Mock(side_effect=accounts), affinity=Mock())
                        payload = {"model": "deepseek-v4.1-flash", "stream": True}
                        if route == "/v1/responses":
                            payload["input"] = "synthetic input"
                        else:
                            payload["messages"] = [{"role": "user", "content": "synthetic input"}]
                        request_body = json.dumps(payload).encode()
                        raw = json.dumps({"code": 11128, "msg": "SYNTHETIC_PRIVATE_MARKER",
                                          "retry_policy": {"retry": False}, "requestId": "safe-request-123"}).encode()
                        transport.reset_mock()
                        transport.side_effect = HTTPError("https://example.invalid", upstream_status,
                                                          "synthetic rejection", {}, io.BytesIO(raw))
                        handler = object.__new__(proxy.Handler)
                        handler.path = route
                        handler.command = "POST"
                        handler.request_version = "HTTP/1.1"
                        handler.requestline = "POST %s HTTP/1.1" % route
                        handler.headers = {"Content-Length": str(len(request_body)),
                                           "Content-Type": "application/json", "X-Realm": "intl",
                                           "X-Session-Id": "synthetic-session",
                                           "Authorization": "Bearer synthetic-local-key"}
                        handler.rfile = io.BytesIO(request_body)
                        handler.wfile = io.BytesIO()
                        handler.log_message = Mock()
                        with patch.object(proxy, "POOL", pool):
                            handler.do_POST()
                        header_bytes, body_bytes = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
                        header_lines = header_bytes.decode("ascii").split("\r\n")
                        self.assertEqual(int(header_lines[0].split()[1]), upstream_status)
                        headers = dict(line.split(": ", 1) for line in header_lines[1:])
                        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
                        self.assertEqual(int(headers["Content-Length"]), len(body_bytes))
                        error = json.loads(body_bytes)["error"]
                        self.assertEqual(error["code"], upstream_status)
                        self.assertEqual(error["type"], "channel_rejected")
                        self.assertEqual(error["upstream_code"], 11128)
                        self.assertIs(error["retryable"], False)
                        self.assertEqual(error["requestId"], "safe-request-123")
                        self.assertIn("channel is not approved", error["message"])
                        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", error["message"])
                        self.assertNotIn("retry_policy", error["message"])
                        transport.assert_called_once()
                        self.assertEqual(pool.pick_for_session.call_count, 1)
                        pool.affinity.unbind.assert_not_called()
                        for account in accounts:
                            account.note_error.assert_not_called()
                            account.note_model_rate_limit.assert_not_called()
                            account.clear_error.assert_not_called()
                            account.clear_model_rate_limit.assert_not_called()
                        expected_rows += 1
                        rows = [json.loads(row) for row in Path(proxy.USAGE_LOG).read_text(encoding="utf-8").splitlines()]
                        self.assertEqual(len(rows), expected_rows)
                        self.assertEqual(rows[-1]["status"], upstream_status)
                        self.assertEqual(json.loads(rows[-1]["message"]), json.loads(raw))
            no_connection.assert_not_called()
            no_connect.assert_not_called()
            no_connect_ex.assert_not_called()
        self.assertFalse(Path(directory).exists(), "Temporary usage data must be removed")


if __name__ == "__main__":
    unittest.main()
