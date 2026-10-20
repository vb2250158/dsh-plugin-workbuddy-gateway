"""Daily CN growth activity with durable admission and official confirmation.

Each account admits at most one activity report per Shanghai calendar day.
An uncertain report is never resent; bounded later checks only read the official
heatmap. Stored confirmation is separate from the billing check-in state.
"""
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
import json
import math
import os
import time
import urllib.error
import urllib.request


BASE = "https://copilot.tencent.com"
SHANGHAI = timezone(timedelta(hours=8))
REASONS = frozenset(("", "not_recorded", "request_failed", "auth_required",
                     "upstream_rejected", "invalid_response", "invalid_state",
                     "storage_failed"))


def today():
    """Return the official activity calendar date, independent of host timezone."""
    return datetime.fromtimestamp(time.time(), SHANGHAI).date().isoformat()


def new_state(day):
    """Create a daily record before any upstream activity is admitted."""
    return {"date": day, "status": "not_started", "checks": 0,
            "reported": False, "nextCheckAt": 0, "reason": "", "confirmedAt": None}


def valid_state(value):
    """Validate persisted fields without silently discarding an admission marker."""
    if not isinstance(value, dict):
        return False
    try:
        day = datetime.strptime(value.get("date", ""), "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        return False
    return (value.get("date") == day
            and all(key in value for key in new_state(day))
            and value.get("status") in ("not_started", "pending", "confirmed", "failed")
            and type(value.get("checks")) is int and value["checks"] >= 0
            and type(value.get("reported")) is bool
            and type(value.get("nextCheckAt")) in (int, float)
            and math.isfinite(value["nextCheckAt"]) and value["nextCheckAt"] >= 0
            and isinstance(value.get("reason"), str) and value["reason"] in REASONS
            and (value.get("confirmedAt") is None or isinstance(value["confirmedAt"], str)))


def public_state(value):
    """Expose current-day confirmation without leaking arbitrary account-file fields."""
    if value is not None and not valid_state(value):
        return {**new_state(today()), "status": "failed", "reason": "invalid_state"}
    if value is None or value["date"] != today():
        return new_state(today())
    return {key: value[key] for key in new_state(value["date"])}


class GrowthError(Exception):
    """A safe, localizable reason; upstream bodies and credentials stay private."""


def request(account, path, body=None):
    """Make one bounded request, with no implicit retry of an activity report."""
    req = urllib.request.Request(
        BASE + path, headers=account.headers("chat"),
        data=None if body is None else json.dumps(body).encode("utf-8"),
        method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise GrowthError("auth_required" if exc.code in (401, 403) else "request_failed") from exc
    except (OSError, urllib.error.URLError, HTTPException) as exc:
        raise GrowthError("request_failed") from exc
    except (ValueError, UnicodeError) as exc:
        raise GrowthError("invalid_response") from exc
    if not isinstance(payload, dict) or type(payload.get("code")) is not int:
        raise GrowthError("invalid_response")
    if payload["code"] != 0:
        raise GrowthError("upstream_rejected")
    return payload.get("data")


class GrowthCheckin:
    """Scheduler-owned activity runner; callers serialize runs for each account."""

    def __init__(self, enabled=False, retry_seconds=300, max_checks=3):
        self.configure(enabled, retry_seconds, max_checks)

    def configure(self, enabled, retry_seconds, max_checks):
        """Validate settings before replacing the active policy."""
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        if type(retry_seconds) is not int or not 30 <= retry_seconds <= 3600:
            raise ValueError("retrySeconds must be an integer from 30 to 3600")
        if type(max_checks) is not int or not 1 <= max_checks <= 10:
            raise ValueError("maxChecks must be an integer from 1 to 10")
        self.enabled, self.retry_seconds, self.max_checks = enabled, retry_seconds, max_checks
        return {"enabled": enabled, "retrySeconds": retry_seconds, "maxChecks": max_checks}

    @staticmethod
    def _save(account, state):
        account.growth_checkin = state
        if account.path:
            try:
                account.save(os.path.dirname(account.path))
            except OSError as exc:
                raise GrowthError("storage_failed") from exc

    @staticmethod
    def _active(account, day):
        data = request(account, "/activity/growth/heatmap")
        record = data.get("today") if isinstance(data, dict) else None
        if (not isinstance(record, dict) or record.get("date") != day
                or type(record.get("is_active")) is not bool):
            raise GrowthError("invalid_response")
        return record["is_active"]

    def run(self, account, stop_event):
        """Check, optionally report once, then confirm; return None when not due.

        Admission is saved before POST, including when its eventual outcome is
        unknown. Exhausted checks remain visibly unconfirmed until the next day.
        Disabling or shutdown stops admission of subsequent requests.
        """
        def cancelled():
            return not self.enabled or stop_event.is_set() or not account.enabled

        if cancelled() or account.realm != "cn" or account.enterprise_id or not account.access_token:
            return None
        raw = account.growth_checkin
        if raw is not None and not valid_state(raw):
            return None  # public_state exposes the corrupt record; do not erase admission.
        day, now = today(), time.time()
        state = new_state(day) if raw is None or raw["date"] != day else dict(raw)
        if state["status"] in ("confirmed", "failed"):
            return None
        if state["checks"] >= self.max_checks:
            state["status"] = "failed"
            try:
                self._save(account, state)
            except GrowthError:
                state["reason"] = "storage_failed"
            return dict(state)
        if now < state["nextCheckAt"]:
            return None
        state.update(status="pending", checks=state["checks"] + 1,
                     nextCheckAt=now + self.retry_seconds, reason="not_recorded")
        try:
            self._save(account, state)
            if cancelled():
                return dict(state)
            if account.expires_at and account.expires_at <= now and not account.refresh():
                raise GrowthError("auth_required")
            if cancelled():
                return dict(state)
            active = self._active(account, day)
            if not active and not state["reported"] and not cancelled() and today() == day:
                from wb_tasks import build_event
                state["reported"] = True
                self._save(account, state)
                if cancelled():
                    return dict(state)
                request(account, "/v2/report", [build_event(account, "chat")])
                if cancelled():
                    return dict(state)
                active = self._active(account, day)
            if active:
                state.update(status="confirmed", reason="", nextCheckAt=0,
                             confirmedAt=datetime.fromtimestamp(time.time(), SHANGHAI).isoformat())
        except GrowthError as exc:
            state["reason"] = str(exc)
            if str(exc) == "storage_failed":
                state["status"] = "failed"
                account.growth_checkin = state
                return dict(state)
        if state["status"] != "confirmed" and state["checks"] >= self.max_checks:
            state["status"] = "failed"
        try:
            self._save(account, state)
        except GrowthError:
            state.update(status="failed", reason="storage_failed")
        return dict(state)
