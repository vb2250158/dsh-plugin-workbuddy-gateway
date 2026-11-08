"""Pure classification of upstream errors for gateway clients."""

import json
import re


CHANNEL_REJECTION_CODE = 11128
_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


def is_channel_rejection(upstream_data):
    """Recognize only an explicit numeric or string 11128 JSON business code."""
    if not isinstance(upstream_data, dict):
        return False
    code = upstream_data.get("code")
    return ((type(code) is int and code == CHANNEL_REJECTION_CODE)
            or (isinstance(code, str) and code == str(CHANNEL_REJECTION_CODE)))


def is_channel_rejection_body(raw):
    """Recognize channel refusal in an upstream body before account rotation."""
    try:
        upstream_data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return False
    return is_channel_rejection(upstream_data)


def channel_rejection_error(upstream_data, http_status):
    """Return safe client fields for explicit code 11128, otherwise None.

    The HTTP status remains the legacy error code. The upstream owns the
    channel rejection; this projection changes neither account state nor retry
    behavior. Only a bounded ASCII request identifier may enter the response.
    """
    if not is_channel_rejection(upstream_data):
        return None
    error = {
        "message": "WorkBuddy rejected this request because this access channel is not approved "
                   "(code 11128). Use a WorkBuddy-approved integration or contact WorkBuddy support.",
        "type": "channel_rejected",
        "code": http_status,
        "upstream_code": CHANNEL_REJECTION_CODE,
        "retryable": False,
    }
    request_id = upstream_data.get("requestId")
    if isinstance(request_id, str) and _REQUEST_ID.fullmatch(request_id):
        error["requestId"] = request_id
    return error
