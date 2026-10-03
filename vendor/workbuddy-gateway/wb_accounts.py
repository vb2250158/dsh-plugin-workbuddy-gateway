import base64
import json
import math
import os
import ssl
import sys
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from wb_fingerprint import derive_id, generate_request_id


def _retryable(exc):
    """Transient network faults worth another attempt (TLS resets, timeouts, 5xx)."""
    if isinstance(exc, ssl.SSLError):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    if isinstance(exc, urllib.error.URLError):
        return True
    if isinstance(exc, (TimeoutError, ConnectionResetError, ConnectionAbortedError, OSError)):
        return True
    return False


def http_json(url, data=None, method=None, headers=None, timeout=30,
              retries=3, backoff=1.0, log=None):
    """urlopen + json decode with retries.

    Chinese networks and CDN edges routinely drop a TLS handshake with
    "SSL: UNEXPECTED_EOF_WHILE_READING"; a single retry almost always
    succeeds, so every upstream call goes through here.
    """
    attempts = max(1, int(retries or 1))
    last = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            url,
            data=data,
            method=method or ("POST" if data is not None else "GET"),
            headers=headers or {},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last = exc
            if attempt >= attempts or not _retryable(exc):
                break
            if log:
                log("network retry %d/%d after %s" % (attempt, attempts, exc))
            time.sleep(backoff * attempt)
    raise last

REALM_CONFIGS = {
    "intl": {
        "name": "国际版 (Global)",
        "chat_upstream": "https://www.workbuddy.ai",
        "billing_upstream": "https://www.workbuddy.ai",
        "origin": "https://www.workbuddy.ai",
        "domain": "www.workbuddy.ai",
        "chat_ua": "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2",
        "billing_ua": "WorkBuddy/5.5.2",
        "info_filename": "workbuddy-desktop-ai.info",
        "cache_dir_name": ".workbuddy-ai",
        "has_checkin": False,
    },
    "cn": {
        "name": "国内版 (China)",
        "chat_upstream": "https://copilot.tencent.com",
        "billing_upstream": "https://www.codebuddy.cn",
        "origin": "https://www.codebuddy.cn",
        "domain": "copilot.tencent.com",
        "chat_ua": "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1",
        "billing_ua": "WorkBuddy/5.5.6",
        "info_filename": "workbuddy-desktop.info",
        "cache_dir_name": ".workbuddy",
        "has_checkin": True,
    },
}

AUTH_STATE_PATH = "/v2/plugin/auth/state"
AUTH_TOKEN_PATH = "/v2/plugin/auth/token"
LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account"
REFRESH_PATH = "/v2/plugin/auth/token/refresh"
CHECKIN_PATH = "/v2/billing/meter/daily-checkin"
GET_RESOURCE_PATH = "/v2/billing/meter/get-user-resource"

# The upstream marks an expired resource package with Status 3. Any other value
# stays usable.
PACKAGE_STATUS_EXPIRED = 3

LOGIN_PENDING = 11217
LOGIN_TTL_SECONDS = 600
USER_AGENT = REALM_CONFIGS['intl']['chat_ua']
DEFAULT_UA_VERSION = '5.5.2'

def get_realm_config(realm):
    return REALM_CONFIGS.get(realm) or REALM_CONFIGS["intl"]

def _checkin_claimed(payload):
    """Read the upstream's claimed/sign-in flag across response revisions."""
    if not isinstance(payload, dict):
        return None
    for key in ("claimed", "hasCheckin", "has_checkin", "isCheckin", "checkedIn", "isClaimed", "received"):
        value = payload.get(key)
        if isinstance(value, bool):
            return value
    for value in payload.values():
        if isinstance(value, dict):
            found = _checkin_claimed(value)
            if found is not None:
                return found
    return None

def _precise_number(source, base_key):
    """Read one numeric field, preferring the ``*Precise`` variant.

    The upstream truncates the plain keys to integers (``CapacityRemain`` = 247)
    while the ``Precise`` keys carry the two-decimal figure the desktop app shows
    (``"247.87"``, as a string). Prefer the precise value and fall back to the
    integer so an older response shape still yields a number.
    """
    precise = source.get(base_key + "Precise")
    if isinstance(precise, str):
        try:
            return float(precise)
        except ValueError:
            pass
    elif isinstance(precise, (int, float)) and not isinstance(precise, bool):
        return float(precise)
    value = source.get(base_key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def _package_name(entry):
    """Package name fallback chain: ``PackageName`` -> ``SubProductName`` -> ``PackageCode``.

    Enterprise and other variants may ship only one of the three, so falling
    through beats rendering an empty label.
    """
    for key in ("PackageName", "SubProductName", "PackageCode"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "Package"


def _package_is_active(entry):
    """Whether a resource package may still be charged against.

    An expired package's credits are still returned by the upstream, so summing
    them inflates the balance (measured on a real account: 155.67 reported as
    655.67). Only explicit expiry counts: an unknown Status or an unparseable
    timestamp stays usable, because hiding spendable credits is the worse error.
    """
    if entry.get("Status") == PACKAGE_STATUS_EXPIRED:
        return False
    expired = entry.get("ExpiredTime")
    if isinstance(expired, str) and expired.strip():
        try:
            when = time.mktime(time.strptime(expired.strip(), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            return True
        if time.time() >= when:
            return False
    return True


def round_credits(value):
    """Round a credit amount to cents.

    Uses floor-plus-half rather than :func:`round`, whose banker's rounding would
    send a value landing exactly on half a cent the other way. Amounts are
    non-negative here, so the floor form is exact enough.
    """
    return math.floor(float(value) * 100 + 0.5) / 100


def _jwt_claims(token):
    try:
        segment = str(token).split(".")[1]
        segment += "=" * (-len(segment) % 4)
        return json.loads(base64.urlsafe_b64decode(segment))
    except Exception:
        return {}

def jwt_exp(token):
    try:
        return int(_jwt_claims(token).get("exp") or 0)
    except Exception:
        return 0

def jwt_uid(token):
    return str(_jwt_claims(token).get("sub") or "")

def jwt_issuer(token):
    return str(_jwt_claims(token).get("iss") or "")

def normalize_epoch(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if number > 1e11:
        number /= 1000.0
    return int(number)

def detect_realm_from_token(token, domain=None):
    iss = jwt_issuer(token).lower()
    dom = str(domain or "").lower()
    if "copilot.tencent.com" in dom or "codebuddy.cn" in dom or "copilot.tencent.com" in iss or "codebuddy.cn" in iss:
        return "cn"
    return "intl"

class Account(object):
    def __init__(self, data, path=None):
        data = data or {}
        self.path = path
        self._state_lock = threading.RLock()
        token = str(data.get("accessToken") or "")
        self.uid = str(data.get("uid") or jwt_uid(token))
        self.nickname = str(data.get("nickname") or "")
        self.domain = str(data.get("domain") or "")
        self.realm = str(data.get("realm") or detect_realm_from_token(token, self.domain))
        if not self.domain:
            self.domain = get_realm_config(self.realm)["domain"]
        self.platform = str(data.get("platform") or "CLI")
        self.enterprise_id = str(data.get("enterpriseId") or "")
        self.access_token = token
        self.refresh_token = str(data.get("refreshToken") or "")
        self.expires_at = normalize_epoch(data.get("expiresAt")) or jwt_exp(token)
        self.added_at = data.get("addedAt") or time.time()
        self.source = str(data.get("source") or "oauth")
        self.enabled = data.get("enabled", True)
        self.last_error = str(data.get("lastError") or "")
        self.cooldown_until = float(data.get("cooldownUntil") or 0)
        raw_limits = data.get("modelRateLimits")
        self.model_rate_limits = {
            str(model): float(reset)
            for model, reset in (raw_limits.items() if isinstance(raw_limits, dict) else [])
            if isinstance(model, str) and isinstance(reset, (int, float))
            and not isinstance(reset, bool) and math.isfinite(reset) and reset > 0
        }
        self.credits = data.get("credits") or None
        self.last_checkin = data.get("lastCheckin") or None
        self.checkin_claimed = data.get("checkinClaimed")

    def to_dict(self):
        return {
            "uid": self.uid,
            "nickname": self.nickname,
            "domain": self.domain,
            "realm": self.realm,
            "platform": self.platform,
            "enterpriseId": self.enterprise_id,
            "accessToken": self.access_token,
            "refreshToken": self.refresh_token,
            "expiresAt": self.expires_at,
            "addedAt": self.added_at,
            "source": self.source,
            "enabled": self.enabled,
            "lastError": self.last_error,
            "cooldownUntil": self.cooldown_until,
            "modelRateLimits": self.active_model_limits(),
            "credits": self.credits,
            "lastCheckin": self.last_checkin,
            "checkinClaimed": self.checkin_claimed,
        }

    def public(self):
        exp = self.expires_at or jwt_exp(self.access_token)
        return {
            "uid": self.uid,
            "nickname": self.nickname or (self.uid[:8] if self.uid else "?"),
            "domain": self.domain,
            "realm": self.realm,
            "platform": self.platform,
            "enterpriseId": self.enterprise_id,
            "enabled": bool(self.enabled),
            "available": self.available(),
            "source": self.source,
            "expiresAt": exp,
            "expiresIn": _human_delta(exp - time.time()) if exp else None,
            "hasRefreshToken": bool(self.refresh_token),
            "lastError": self.last_error,
            "inCooldown": self.cooldown_until > time.time(),
            "cooldownFor": round(max(0.0, self.cooldown_until - time.time())) or None,
            "modelRateLimits": self.active_model_limits(),
            "addedAt": self.added_at,
            "file": os.path.basename(self.path) if self.path else None,
            "credits": self.credits,
            "lastCheckin": self.last_checkin,
            "checkinClaimed": self.checkin_claimed_today() if self.realm == "cn" else None,
            "canCheckin": self.realm == "cn",
            "machineId": derive_id(self.uid, "machine"),
            "sessionId": derive_id(self.uid, "session"),
        }

    def save(self, directory):
        os.makedirs(directory, exist_ok=True)
        name = (self.uid or uuid.uuid4().hex) + ".json"
        path = os.path.join(directory, name)
        with self._state_lock:
            # Every caller, including refresh/check-in, writes under the same
            # lock so concurrent model limits cannot replace a newer snapshot.
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                             prefix=name + ".", suffix=".tmp", delete=False) as fh:
                tmp = fh.name
                try:
                    json.dump(self.to_dict(), fh, ensure_ascii=False, indent=2)
                except BaseException:
                    fh.close()
                    os.unlink(tmp)
                    raise
            try:
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            self.path = path
            return path

    def delete(self):
        if self.path and os.path.exists(self.path):
            os.remove(self.path)

    def available(self, model=None):
        """Eligible for selection; expired tokens need refresh there, never on status reads."""
        if not self.enabled or not self.access_token:
            return False
        if self.cooldown_until > time.time():
            return False
        if model and self.model_reset_at(model) > time.time():
            return False
        exp = self.expires_at or jwt_exp(self.access_token)
        return not exp or exp > time.time() or bool(self.refresh_token)

    def ready(self):
        if not self.available():
            return False
        exp = self.expires_at or jwt_exp(self.access_token)
        if not exp:
            return True
        remaining = exp - time.time()
        if remaining > 120:
            return True
        if remaining > 0:
            self.refresh()
            return True
        return self.refresh()

    def active_model_limits(self):
        """Public model reset timestamps in epoch seconds; expired entries are omitted."""
        with self._state_lock:
            now = time.time()
            return {m: t for m, t in self.model_rate_limits.items() if t > now}

    def checkin_claimed_today(self):
        """Return whether the stored check-in confirmation belongs to today."""
        if self.checkin_claimed is not True or not isinstance(self.last_checkin, str):
            return False
        return self.last_checkin[:10] == time.strftime("%Y-%m-%d", time.localtime())

    def ready_for_model(self, model=None):
        """A model restriction leaves this account available for other models."""
        if model and self.model_reset_at(model) > time.time():
            return False
        return self.ready()

    def model_reset_at(self, model):
        """Return an epoch-seconds deadline, or zero if none is recorded."""
        with self._state_lock:
            return self.model_rate_limits.get(str(model), 0) if model else 0

    def note_model_rate_limit(self, model, reset_at):
        """Persist a model limit without changing account-wide authentication state."""
        with self._state_lock:
            self.model_rate_limits[str(model)] = max(reset_at, self.model_reset_at(model))
            if self.path:
                self.save(os.path.dirname(self.path))

    def clear_model_rate_limit(self, model):
        """Remove only expired limits; a concurrent 429 wins over an older success."""
        with self._state_lock:
            if model in self.model_rate_limits and self.model_rate_limits[model] <= time.time():
                del self.model_rate_limits[model]
                if self.path:
                    self.save(os.path.dirname(self.path))

    def headers(self, purpose="chat"):
        cfg = get_realm_config(self.realm)
        ua = cfg["chat_ua"] if purpose == "chat" else cfg["billing_ua"]
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": ua,
            "Origin": cfg["origin"],
            "Referer": cfg["origin"] + "/",
            "Authorization": "Bearer " + self.access_token,
            "X-User-Id": self.uid,
            "X-Domain": self.domain or cfg["domain"],
        }
        headers["X-Request-ID"] = generate_request_id(self.uid)
        headers["X-Machine-ID"] = derive_id(self.uid, "machine")
        headers["X-Session-ID"] = derive_id(self.uid, "session")
        if self.enterprise_id:
            headers["X-Enterprise-Id"] = self.enterprise_id
            headers["X-Tenant-Id"] = self.enterprise_id
        else:
            headers["X-No-Enterprise-Id"] = "1"
        if self.realm == "cn":
            headers["X-Product"] = "SaaS"
        return headers

    def refresh(self):
        if not self.refresh_token:
            self.last_error = "no refresh token; sign in again"
            return False
        cfg = get_realm_config(self.realm)
        url = cfg["chat_upstream"] + REFRESH_PATH
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": cfg["billing_ua"],
            "Origin": cfg["origin"],
            "Referer": cfg["origin"] + "/",
            "X-Refresh-Token": self.refresh_token,
            "X-Auth-Refresh-Source": "workbuddy" if self.realm == "cn" else "plugin",
            "X-User-Id": self.uid,
            "X-Domain": self.domain or cfg["domain"],
        }
        if self.enterprise_id:
            headers["X-Enterprise-Id"] = self.enterprise_id
        try:
            payload = http_json(url, data=b"{}", method="POST", headers=headers, timeout=30)
        except Exception as exc:
            self.last_error = "refresh failed: %s" % exc
            return False
        data = (payload.get("data") or {})
        data = data.get("data") or data
        token = data.get("accessToken")
        if not token:
            self.last_error = "refresh returned no token (%s)" % payload.get("msg")
            return False
        self.access_token = token
        self.refresh_token = data.get("refreshToken") or self.refresh_token
        self.expires_at = jwt_exp(token) or self.expires_at
        self.last_error = ""
        self.cooldown_until = 0
        if self.path and os.path.exists(os.path.dirname(self.path)):
            self.save(os.path.dirname(self.path))
        return True

    def checkin(self):
        if self.realm != "cn":
            return {"ok": False, "error": "checkin is only available for CN realm accounts"}
        cfg = get_realm_config("cn")
        url = cfg["billing_upstream"] + CHECKIN_PATH
        headers = self.headers(purpose="billing")
        try:
            payload = http_json(url, data=b"{}", method="POST", headers=headers, timeout=15)
            code = payload.get("code", -1)
            msg = payload.get("msg") or "ok"
            claimed = _checkin_claimed(payload.get("data"))
            if claimed is not None:
                self.checkin_claimed = claimed
            # Code 10001 means the daily reward was already claimed.
            if code == 0 or code == 10001:
                self.checkin_claimed = True
                self.last_checkin = time.strftime("%Y-%m-%d %H:%M:%S")
            if self.path and os.path.exists(os.path.dirname(self.path)):
                self.save(os.path.dirname(self.path))
            return {"ok": (code == 0 or code == 10001), "claimed": self.checkin_claimed_today(),
                    "code": code, "msg": msg, "data": payload.get("data")}
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read().decode("utf-8") or "{}")
                claimed = _checkin_claimed(body.get("data"))
                code = body.get("code")
                message = body.get("msg") or ("HTTP %d" % exc.code)
                # The billing API uses an HTTP error for the already-claimed
                # case on some deployments. Preserve that state as claimed.
                if code == 10001:
                    claimed = True
                if claimed is not None:
                    self.checkin_claimed = claimed
                    if claimed:
                        self.last_checkin = time.strftime("%Y-%m-%d %H:%M:%S")
                        if self.path and os.path.exists(os.path.dirname(self.path)):
                            self.save(os.path.dirname(self.path))
                return {"ok": claimed is True, "claimed": self.checkin_claimed_today(), "code": code, "msg": message,
                        "error": None if claimed is True else message}
            except Exception:
                return {"ok": False, "error": "HTTP %d" % exc.code}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def fetch_credits(self):
        cfg = get_realm_config(self.realm)
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        body = {
            "PageNumber": 1,
            "PageSize": 100,
            "ProductCode": "p_tcaca",
            "Status": [0, 3],
            "PackageEndTimeRangeBegin": now,
            "PackageEndTimeRangeEnd": "2036-01-01 00:00:00",
        }
        url = cfg["billing_upstream"] + GET_RESOURCE_PATH
        headers = self.headers(purpose="billing")
        try:
            res = http_json(url, data=json.dumps(body).encode(), method="POST", headers=headers, timeout=30)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        data = res.get("data", {}).get("Response", {}).get("Data", {})
        accounts = data.get("Accounts") or []
        tot_remain, tot_used, tot_size, tot_expired = 0.0, 0.0, 0.0, 0.0
        packages = []
        for a in accounts:
            pkg_name = _package_name(a)
            if _precise_number(a, "CycleCapacitySize") > 0:
                remain = _precise_number(a, "CycleCapacityRemain")
                size = _precise_number(a, "CycleCapacitySize")
                used = max(0.0, size - remain)
                cycle_used = _precise_number(a, "CycleCapacityUsed")
                if cycle_used > used:
                    used = cycle_used
                    remain = max(0.0, size - used)
            else:
                remain = _precise_number(a, "CapacityRemain")
                used = _precise_number(a, "CapacityUsed")
                size = _precise_number(a, "CapacitySize")
            # Expired packages still report their credits but cannot be spent, so
            # they are summed separately instead of into the usable balance.
            active = _package_is_active(a)
            if active:
                tot_remain += remain
                tot_used += used
                tot_size += size
            else:
                tot_expired += remain
            packages.append({
                "name": pkg_name,
                "remain": round_credits(remain),
                "used": round_credits(used),
                "size": round_credits(size),
                "active": active,
            })
        self.credits = {
            "remain": round_credits(tot_remain),
            "used": round_credits(tot_used),
            "size": round_credits(tot_size),
            "expired": round_credits(tot_expired),
            "packages": packages,
            "updated_at": time.time(),
            "updated_iso": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if self.path and os.path.exists(os.path.dirname(self.path)):
            self.save(os.path.dirname(self.path))
        return {"ok": True, "credits": self.credits}

    def note_error(self, message, cooldown=60, single_account=False):
        self.last_error = str(message)[:200]
        actual_cooldown = 3 if single_account else cooldown
        self.cooldown_until = time.time() + actual_cooldown

    def clear_error(self):
        if self.last_error or self.cooldown_until:
            self.last_error = ""
            self.cooldown_until = 0

def _human_delta(seconds):
    if seconds is None: return None
    if seconds <= 0: return "expired"
    days = seconds / 86400.0
    if days >= 1: return "%.0f days" % days
    hours = seconds / 3600.0
    if hours >= 1: return "%.1f hours" % hours
    return "%d min" % int(seconds / 60)

class SessionAffinity(object):
    def __init__(self, ttl=7200, max_entries=5000):
        self.ttl = ttl
        self.max_entries = max_entries
        self.bindings = {}
        self._lock = threading.Lock()
    def get(self, key):
        if not key: return None
        with self._lock:
            entry = self.bindings.get(key)
            if not entry: return None
            uid, exp = entry
            if time.time() > exp:
                self.bindings.pop(key, None)
                return None
            self.bindings[key] = (uid, time.time() + self.ttl)
            return uid
    def bind(self, key, uid):
        if not key or not uid: return
        with self._lock:
            if len(self.bindings) >= self.max_entries:
                now = time.time()
                self.bindings = {k: v for k, v in self.bindings.items() if v[1] > now}
            self.bindings[key] = (uid, time.time() + self.ttl)
    def unbind(self, key):
        if not key: return
        with self._lock:
            self.bindings.pop(key, None)

class AccountPool(object):
    def __init__(self, directory, log=None):
        self.dir = directory
        self.log = log or (lambda msg: None)
        self.accounts = []
        self.logins = {}
        self._lock = threading.RLock()
        self._cursor = 0
        self.affinity = SessionAffinity()

    def load(self):
        with self._lock:
            self.accounts = []
            if not os.path.isdir(self.dir): return self.accounts
            for name in sorted(os.listdir(self.dir)):
                if not name.endswith(".json"): continue
                path = os.path.join(self.dir, name)
                try:
                    with open(path, encoding="utf-8") as fh:
                        account = Account(json.load(fh), path)
                except Exception as exc:
                    self.log("account %s unreadable: %s" % (name, exc))
                    continue
                if account.uid:
                    self.accounts.append(account)
            return self.accounts

    def list_public(self, realm=None):
        with self._lock:
            accs = self.accounts if not realm else [a for a in self.accounts if a.realm == realm]
            return [a.public() for a in accs]

    def get(self, uid):
        with self._lock:
            for account in self.accounts:
                if account.uid == uid: return account
        return None

    def add(self, account):
        with self._lock:
            existing = self.get(account.uid)
            if existing is not None:
                account.added_at = existing.added_at
                account.path = existing.path
                if not account.credits and existing.credits:
                    account.credits = existing.credits
                if not account.last_checkin and existing.last_checkin:
                    account.last_checkin = existing.last_checkin
                if not account.model_rate_limits and existing.model_rate_limits:
                    account.model_rate_limits = dict(existing.model_rate_limits)
                self.accounts[self.accounts.index(existing)] = account
            else:
                self.accounts.append(account)
            account.save(self.dir)
            return account

    def remove(self, uid):
        with self._lock:
            account = self.get(uid)
            if account is None: return False
            account.delete()
            self.accounts.remove(account)
            return True

    def set_enabled(self, uid, enabled):
        account = self.get(uid)
        if account is None: return None
        account.enabled = bool(enabled)
        if enabled: account.clear_error()
        account.save(self.dir)
        return account.public()

    def set_all_enabled(self, enabled, realm=None):
        with self._lock:
            for account in self.accounts:
                if realm and account.realm != realm: continue
                account.enabled = bool(enabled)
                if enabled: account.clear_error()
                account.save(self.dir)

    def count_ready(self, realm=None, model=None):
        with self._lock:
            snapshot = [a for a in self.accounts if not realm or a.realm == realm]
        # This count bounds attempts and feeds status pages; credential refresh
        # belongs to selection, never to a status read.
        return sum(1 for a in snapshot if a.available(model))

    def pick_for_session(self, realm=None, session_key=None, exclude=None, model=None):
        exclude = exclude or set()
        if session_key:
            bound_uid = self.affinity.get(session_key)
            if bound_uid and bound_uid not in exclude:
                account = self.get(bound_uid)
                if account and account.realm == realm and account.ready_for_model(model):
                    return account
                self.affinity.unbind(session_key)
        account = self.pick(realm=realm, exclude=exclude, model=model)
        if account and session_key:
            self.affinity.bind(session_key, account.uid)
        return account

    def pick(self, realm=None, exclude=None, model=None):
        exclude = exclude or set()
        with self._lock:
            snapshot = [a for a in self.accounts if not realm or a.realm == realm]
            start = self._cursor
        total = len(snapshot)
        if total == 0: return None
        for offset in range(total):
            index = (start + offset) % total
            account = snapshot[index]
            if account.uid in exclude: continue
            if account.ready_for_model(model):
                with self._lock: self._cursor = (index + 1) % total
                return account
        return None

    def next_model_reset(self, realm, model):
        """Earliest model deadline among otherwise eligible accounts, without refresh I/O."""
        now = time.time()
        with self._lock:
            candidates = [a for a in self.accounts if a.realm == realm and a.enabled and a.access_token
                          and a.cooldown_until <= now
                          and (not a.expires_at or a.expires_at > now or a.refresh_token)]
        deadlines = [a.model_reset_at(model) for a in candidates]
        return min(deadlines) if deadlines and all(t > now for t in deadlines) else None

    def representative(self, realm=None):
        with self._lock:
            candidates = [a for a in self.accounts if not realm or a.realm == realm]
            for account in candidates:
                if account.access_token: return account
            return candidates[0] if candidates else None

    def start_login(self, realm="intl", platform="CLI"):
        cfg = get_realm_config(realm)
        url = "%s%s?platform=%s" % (cfg["chat_upstream"], AUTH_STATE_PATH, urllib.parse.quote(str(platform)))
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": cfg["billing_ua"],
            "Origin": cfg["origin"],
            "Referer": cfg["origin"] + "/",
        }
        payload = http_json(url, data=b"{}", method="POST", headers=headers,
                            timeout=30, retries=3, log=self.log)
        data = payload.get("data") or {}
        state = data.get("state")
        auth_url = data.get("authUrl")
        if not state or not auth_url:
            raise RuntimeError("auth/state returned no state/authUrl: %s" % payload)
        with self._lock:
            self.logins[state] = {"created": time.time(), "platform": platform, "realm": realm}
        return {"state": state, "authUrl": auth_url, "realm": realm, "platform": platform}

    def poll_login(self, state):
        state = str(state or "").strip()
        with self._lock:
            info = self.logins.get(state)
        if not info:
            return {"status": "unknown", "message": "state not recognised - start the login again"}
        if time.time() - info["created"] > LOGIN_TTL_SECONDS:
            with self._lock: self.logins.pop(state, None)
            return {"status": "expired", "message": "login window expired - start again"}
        realm = info.get("realm") or "intl"
        cfg = get_realm_config(realm)
        url = "%s%s?state=%s" % (cfg["chat_upstream"], AUTH_TOKEN_PATH, urllib.parse.quote(state))
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": cfg["billing_ua"],
            "Origin": cfg["origin"],
            "Referer": cfg["origin"] + "/",
        }
        try:
            payload = http_json(url, method="GET", headers=headers, timeout=30, retries=2)
        except Exception as exc:
            return {"status": "pending", "message": "poll error: %s" % exc}
        code = payload.get("code")
        if code == LOGIN_PENDING:
            return {"status": "pending", "message": payload.get("msg") or "waiting for browser login"}
        if code != 0:
            return {"status": "error", "message": "code=%s msg=%s" % (code, payload.get("msg"))}
        data = payload.get("data") or {}
        token = data.get("accessToken")
        if not token:
            return {"status": "pending", "message": "waiting for token"}
        uid = jwt_uid(token)
        nickname = ""
        try:
            acct_url = "%s%s?state=%s" % (cfg["chat_upstream"], LOGIN_ACCOUNT_PATH, urllib.parse.quote(state))
            acct_headers = dict(headers)
            acct_headers["Authorization"] = "Bearer " + token
            req_acct = urllib.request.Request(acct_url, method="GET", headers=acct_headers)
            with urllib.request.urlopen(req_acct, timeout=15) as resp_acct:
                profile = json.loads(resp_acct.read().decode("utf-8"))
                profile_data = profile.get("data") or {}
                nickname = str(profile_data.get("nickname") or "")
        except Exception: pass
        account = Account({
            "uid": uid,
            "nickname": nickname or uid[:8],
            "domain": data.get("domain") or cfg["domain"],
            "realm": realm,
            "platform": info["platform"],
            "accessToken": token,
            "refreshToken": data.get("refreshToken") or "",
            "expiresAt": normalize_epoch(data.get("expiresAt")) or jwt_exp(token),
            "source": "oauth",
            "enabled": True,
        })
        self.add(account)
        if realm == "cn":
            try: account.checkin()
            except Exception: pass
        with self._lock: self.logins.pop(state, None)
        return {"status": "ok", "account": account.public()}

    def cancel_login(self, state):
        with self._lock: return self.logins.pop(state, None) is not None

    def import_desktop_credential(self, path=None, realm=None, source="desktop-app"):
        if not path:
            found = []
            candidates = desktop_credential_candidates()
            for p, r in candidates:
                if realm and r != realm: continue
                try:
                    acc = self.import_desktop_credential(path=p, realm=r, source=source)
                    if acc: found.append(acc)
                except Exception: pass
            return found
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        auth = blob.get("auth") or {}
        profile = blob.get("account") or {}
        token = str(auth.get("accessToken") or "")
        if not token: raise RuntimeError("no accessToken in %s" % path)
        detected_realm = realm or detect_realm_from_token(token, auth.get("domain"))
        cfg = get_realm_config(detected_realm)
        account = Account({
            "uid": profile.get("uid") or jwt_uid(token),
            "nickname": profile.get("nickname") or "",
            "domain": auth.get("domain") or cfg["domain"],
            "realm": detected_realm,
            "platform": "CLI",
            "enterpriseId": profile.get("enterpriseId") or "",
            "accessToken": token,
            "refreshToken": auth.get("refreshToken") or "",
            "expiresAt": normalize_epoch(auth.get("expiresAt")) or jwt_exp(token),
            "source": source,
            "enabled": True,
        })
        self.add(account)
        # Read credits after check-in so any daily reward is included.
        if detected_realm == "cn":
            account.checkin()
        account.fetch_credits()
        return account

def desktop_auth_dir():
    """Return the platform's desktop credential directory.

    ``WORKBUDDY_DESKTOP_AUTH_DIR`` is an escape hatch for packaged desktop
    builds that choose a different application data root.
    """
    override = os.environ.get("WORKBUDDY_DESKTOP_AUTH_DIR")
    if override:
        return os.path.expanduser(override)
    home = os.path.expanduser("~")
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    elif sys.platform == "darwin":
        root = os.path.join(home, "Library", "Application Support")
    else:
        root = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(root, "CodeBuddyExtension", "Data", "Public", "auth")

def desktop_credential_candidates():
    base = desktop_auth_dir()
    out = []
    if not os.path.isdir(base): return out
    p_intl = os.path.join(base, "workbuddy-desktop-ai.info")
    if os.path.isfile(p_intl): out.append((p_intl, "intl"))
    p_cn = os.path.join(base, "workbuddy-desktop.info")
    if os.path.isfile(p_cn): out.append((p_cn, "cn"))
    return out


def scan_desktop_credentials():
    """Describe the desktop-app credentials found on this machine.

    Read-only: nothing is added to the pool. The dashboard shows the result
    and lets the user decide which ones to import, so the proxy never
    silently adopts the desktop client's login.
    """
    found = []
    for path, realm in desktop_credential_candidates():
        cfg = get_realm_config(realm)
        item = {
            "path": path,
            "file": os.path.basename(path),
            "realm": realm,
            "realmName": cfg["name"],
            "domain": cfg["domain"],
            "readable": False,
            "valid": False,
            "uid": "",
            "nickname": "",
            "expiresAt": 0,
            "error": "",
        }
        try:
            with open(path, encoding="utf-8") as fh:
                blob = json.load(fh)
            auth = blob.get("auth") or {}
            profile = blob.get("account") or {}
            token = str(auth.get("accessToken") or "")
            item["readable"] = True
            if not token:
                item["error"] = "no accessToken inside the file"
                found.append(item)
                continue
            exp = normalize_epoch(auth.get("expiresAt")) or jwt_exp(token) or 0
            item.update({
                "valid": True,
                "uid": profile.get("uid") or jwt_uid(token),
                "nickname": profile.get("nickname") or "",
                "domain": auth.get("domain") or cfg["domain"],
                "expiresAt": exp,
                "expiresIn": _human_delta(exp - time.time()) if exp else None,
            })
        except Exception as exc:
            item["error"] = str(exc)
        found.append(item)
    return found
