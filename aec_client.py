import configparser
import datetime
import hashlib
import hmac
import http.client
import json
import os
import re
import ssl
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from collections import deque


def _redact_xml(text: str) -> str:
    return re.sub(
        r"(<SecretAccessKey>)(.*?)(</SecretAccessKey>)",
        r"\1[REDACTED]\3",
        text,
        flags=re.DOTALL,
    )


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def xml_to_dict(elem: ET.Element):
    children = list(elem)
    if not children:
        return (elem.text or "").strip()
    result = {}
    for child in children:
        key = _strip_ns(child.tag)
        val = xml_to_dict(child)
        if key in result:
            if not isinstance(result[key], list):
                result[key] = [result[key]]
            result[key].append(val)
        else:
            result[key] = val
    return result


def parse_xml_safe(raw: bytes):
    if not raw or not raw.strip():
        return {}
    try:
        return xml_to_dict(ET.fromstring(raw))
    except ET.ParseError:
        return {"raw": raw.decode("utf-8", errors="replace")}


class EmulatorClient:
    """Stateless-friendly AWS SigV4 client for the local AWS Emulator."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 9297,
        region: str = "us-east-1",
        emulator_home: str | None = None,
    ):
        self.host = host
        self.port = port
        self.region = region
        self.emulator_home = emulator_home or os.path.expanduser("~/.aws/emulator")
        self._lock = threading.Lock()
        self._log_seq = 0
        self._history = deque(maxlen=150)
        # In-memory IAM user credentials created during this console session:
        # username -> {"access_key_id": ..., "secret_access_key": ..., "arn": ...}
        self._session_users: dict[str, dict[str, str]] = {}

    @property
    def port_dir(self) -> str:
        return os.path.join(self.emulator_home, str(self.port))

    @property
    def ca_bundle(self) -> str:
        return os.path.join(self.port_dir, "ca.pem")

    @property
    def creds_file(self) -> str:
        return os.path.join(self.port_dir, "emulator_credentials")

    @property
    def endpoint_url(self) -> str:
        return f"https://{self.host}:{self.port}"

    def _ssl_context(self) -> ssl.SSLContext:
        if not os.path.exists(self.ca_bundle):
            raise FileNotFoundError(
                f"Emulator CA bundle not found at {self.ca_bundle}. Is AWS Emulator running on port {self.port}?"
            )
        return ssl.create_default_context(cafile=self.ca_bundle)

    def _load_root_credentials(self) -> tuple[str, str, str | None]:
        if not os.path.exists(self.creds_file):
            raise FileNotFoundError(
                f"Emulator credentials not found at {self.creds_file}. Is AWS Emulator running on port {self.port}?"
            )
        cfg = configparser.ConfigParser()
        cfg.read(self.creds_file)
        if "default" not in cfg:
            raise RuntimeError(f"Missing [default] profile in {self.creds_file}")
        s = cfg["default"]
        return s["aws_access_key_id"], s["aws_secret_access_key"], s.get("aws_session_token")

    def resolve_credentials(self, caller: str = "root"):
        if caller in ("anonymous", "unsigned", ""):
            return None, "anonymous"
        if caller == "root":
            return self._load_root_credentials(), "root"
        with self._lock:
            info = self._session_users.get(caller)
        if not info:
            raise ValueError(
                f"No session access key stored for IAM user '{caller}'. Create an access key for them in the IAM tab first."
            )
        return (info["access_key_id"], info["secret_access_key"], None), f"user:{caller}"

    def register_session_user(self, username: str, access_key_id: str, secret_access_key: str):
        with self._lock:
            self._session_users[username] = {
                "access_key_id": access_key_id,
                "secret_access_key": secret_access_key,
            }

    def unregister_session_user(self, username: str):
        with self._lock:
            self._session_users.pop(username, None)

    def list_session_users(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {"username": u, "access_key_id": data["access_key_id"]}
                for u, data in sorted(self._session_users.items())
            ]

    def get_history(self) -> list[dict]:
        with self._lock:
            return list(self._history)

    def clear_history(self):
        with self._lock:
            self._history.clear()

    def _record(
        self,
        *,
        service: str,
        operation: str,
        method: str,
        target: str,
        caller_label: str,
        signed: bool,
        status: int,
        reason: str,
        duration_ms: float,
        req_headers: dict[str, str],
        req_body: bytes,
        resp_headers: dict[str, str],
        resp_body: bytes,
    ):
        safe_req_headers = {
            k: ("[REDACTED]" if k.lower() in ("authorization", "x-amz-security-token") else v)
            for k, v in req_headers.items()
        }
        try:
            req_preview = req_body[:4000].decode("utf-8")
        except UnicodeDecodeError:
            req_preview = f"<binary {len(req_body)} bytes>"
        try:
            resp_preview = _redact_xml(resp_body[:8000].decode("utf-8"))
        except UnicodeDecodeError:
            resp_preview = f"<binary {len(resp_body)} bytes>"

        with self._lock:
            self._log_seq += 1
            self._history.appendleft(
                {
                    "id": self._log_seq,
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime(
                        "%H:%M:%S.%f"
                    )[:-3]
                    + "Z",
                    "service": service,
                    "operation": operation,
                    "method": method,
                    "target": target,
                    "caller": caller_label,
                    "signed": signed,
                    "status": status,
                    "reason": reason,
                    "duration_ms": round(duration_ms, 1),
                    "request_headers": safe_req_headers,
                    "request_body": req_preview,
                    "response_headers": resp_headers,
                    "response_body": resp_preview,
                }
            )

    @staticmethod
    def _sign_key(secret_key: str, date_stamp: str, region: str, service: str) -> bytes:
        k_date = hmac.new(f"AWS4{secret_key}".encode(), date_stamp.encode(), hashlib.sha256).digest()
        k_region = hmac.new(k_date, region.encode(), hashlib.sha256).digest()
        k_service = hmac.new(k_region, service.encode(), hashlib.sha256).digest()
        return hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()

    def health(self) -> dict:
        t0 = time.perf_counter()
        try:
            ctx = self._ssl_context()
            conn = http.client.HTTPSConnection(self.host, self.port, context=ctx, timeout=4)
            conn.request("GET", "/__admin/health")
            resp = conn.getresponse()
            body = resp.read().decode("utf-8", errors="replace").strip()
            conn.close()
            return {
                "ok": resp.status == 200,
                "status": resp.status,
                "body": body,
                "endpoint": self.endpoint_url,
                "region": self.region,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            }
        except Exception as exc:
            return {
                "ok": False,
                "status": 0,
                "error": str(exc),
                "endpoint": self.endpoint_url,
                "region": self.region,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            }

    def request(
        self,
        *,
        service: str,
        method: str,
        path: str,
        operation: str = "",
        query_params: dict[str, str] | None = None,
        body: bytes = b"",
        extra_headers: dict[str, str] | None = None,
        caller: str = "root",
        region: str | None = None,
        record: bool = True,
    ) -> dict:
        region = region or self.region
        query_params = query_params or {}
        extra_headers = dict(extra_headers or {})
        creds, caller_label = self.resolve_credentials(caller)
        signed = creds is not None

        canonical_qs = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(str(v), safe='-_.~')}"
            for k, v in sorted(query_params.items())
        )
        req_target = f"{path}?{canonical_qs}" if canonical_qs else path

        headers = {"host": f"{self.host}:{self.port}"}
        for k, v in extra_headers.items():
            headers[k.lower()] = str(v)

        if signed:
            access_key, secret_key, session_token = creds
            now = datetime.datetime.now(datetime.timezone.utc)
            amz_date = now.strftime("%Y%m%dT%H%M%SZ")
            date_stamp = now.strftime("%Y%m%d")
            payload_hash = hashlib.sha256(body).hexdigest()

            headers["x-amz-date"] = amz_date
            if service == "s3":
                headers["x-amz-content-sha256"] = payload_hash
            if session_token:
                headers["x-amz-security-token"] = session_token

            sorted_keys = sorted(headers.keys())
            canonical_headers = "".join(f"{k}:{headers[k].strip()}\n" for k in sorted_keys)
            signed_headers = ";".join(sorted_keys)
            canonical_uri = urllib.parse.quote(path, safe="/-_.~")

            canonical_request = "\n".join(
                [method, canonical_uri, canonical_qs, canonical_headers, signed_headers, payload_hash]
            )
            credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
            string_to_sign = "\n".join(
                [
                    "AWS4-HMAC-SHA256",
                    amz_date,
                    credential_scope,
                    hashlib.sha256(canonical_request.encode()).hexdigest(),
                ]
            )
            signature = hmac.new(
                self._sign_key(secret_key, date_stamp, region, service),
                string_to_sign.encode(),
                hashlib.sha256,
            ).hexdigest()
            headers["authorization"] = (
                f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            )

        t0 = time.perf_counter()
        ctx = self._ssl_context()
        conn = http.client.HTTPSConnection(self.host, self.port, context=ctx, timeout=15)
        conn.request(method, req_target, body=body if body else None, headers=headers)
        resp = conn.getresponse()
        resp_body = resp.read()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        status = resp.status
        reason = resp.reason
        conn.close()
        duration_ms = (time.perf_counter() - t0) * 1000

        if record:
            self._record(
                service=service,
                operation=operation or f"{method} {path}",
                method=method,
                target=req_target,
                caller_label=caller_label,
                signed=signed,
                status=status,
                reason=reason,
                duration_ms=duration_ms,
                req_headers=headers,
                req_body=body,
                resp_headers=resp_headers,
                resp_body=resp_body,
            )

        return {
            "status": status,
            "reason": reason,
            "headers": resp_headers,
            "body": resp_body,
            "duration_ms": round(duration_ms, 1),
            "caller": caller_label,
            "signed": signed,
        }

    def query_call(
        self,
        service: str,
        version: str,
        params: dict[str, str],
        caller: str = "root",
        region: str | None = None,
    ) -> dict:
        form = {"Version": version, **params}
        body = urllib.parse.urlencode(form).encode("utf-8")
        return self.request(
            service=service,
            method="POST",
            path="/",
            operation=params.get("Action", service),
            body=body,
            extra_headers={"Content-Type": "application/x-www-form-urlencoded"},
            caller=caller,
            region=region,
        )

    def json_call(
        self,
        service: str,
        target: str,
        payload: dict,
        caller: str = "root",
        content_type: str = "application/x-amz-json-1.0",
        region: str | None = None,
    ) -> dict:
        body = json.dumps(payload).encode("utf-8")
        op = target.split(".", 1)[-1] if "." in target else target
        return self.request(
            service=service,
            method="POST",
            path="/",
            operation=op,
            body=body,
            extra_headers={"Content-Type": content_type, "X-Amz-Target": target},
            caller=caller,
            region=region,
        )
