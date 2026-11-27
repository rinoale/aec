#!/usr/bin/env python3
import base64
import json
import mimetypes
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from aec_client import EmulatorClient, parse_xml_safe

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
AEC_HOST = os.environ.get("AEC_HOST", "127.0.0.1")
AEC_PORT = int(os.environ.get("AEC_PORT", "9298"))
EMULATOR_HOST = os.environ.get("EMULATOR_HOST", "127.0.0.1")
EMULATOR_PORT = int(os.environ.get("EMULATOR_PORT", "9297"))
DEFAULT_REGION = os.environ.get("AWS_REGION", "us-east-1")

client = EmulatorClient(host=EMULATOR_HOST, port=EMULATOR_PORT, region=DEFAULT_REGION)


def _as_list(val):
    if val is None or val == "":
        return []
    return val if isinstance(val, list) else [val]


def _extract_error(resp: dict) -> str:
    body = resp["body"]
    if not body:
        return f"HTTP {resp['status']} {resp['reason']}"
    text = body.decode("utf-8", errors="replace").strip()
    if text.startswith("{"):
        try:
            data = json.loads(text)
            return data.get("message") or data.get("Message") or data.get("__type") or text
        except json.JSONDecodeError:
            return text
    if text.startswith("<"):
        parsed = parse_xml_safe(body)
        if isinstance(parsed, dict):
            err = parsed.get("Error") or parsed.get("Errors", {}).get("Error") or parsed
            if isinstance(err, list):
                err = err[0]
            if isinstance(err, dict):
                code = err.get("Code", "")
                msg = err.get("Message", "")
                if code or msg:
                    return f"{code}: {msg}" if code and msg else (msg or code)
    return text[:400]


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "AEC/0.1"

    def log_message(self, format, *args):
        pass

    def _send_json(self, data, status: int = 200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _serve_static(self, rel_path: str):
        if rel_path in ("", "/"):
            rel_path = "index.html"
        rel_path = rel_path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, rel_path))
        if not full.startswith(os.path.realpath(STATIC_DIR)) or not os.path.isfile(full):
            self.send_error(404, "Not Found")
            return
        mime, _ = mimetypes.guess_type(full)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", f"{mime or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _caller_and_region(self, qs: dict, body: dict | None = None):
        body = body or {}
        caller = body.get("caller") or qs.get("caller", ["root"])[0] or "root"
        region = body.get("region") or qs.get("region", [client.region])[0] or client.region
        return caller, region

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if not path.startswith("/api/"):
            self._serve_static(path)
            return

        try:
            caller, region = self._caller_and_region(qs)

            if path == "/api/health":
                health = client.health()
                health["session_users"] = client.list_session_users()
                self._send_json(health)
                return

            if path == "/api/identity":
                r = client.query_call("sts", "2011-06-15", {"Action": "GetCallerIdentity"}, caller, region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                res = parse_xml_safe(r["body"]).get("GetCallerIdentityResult", {})
                self._send_json({"ok": True, "status": r["status"], "identity": res})
                return

            if path == "/api/history":
                self._send_json({"items": client.get_history()})
                return

            # ---- S3 ----
            if path == "/api/s3/buckets":
                r = client.request(service="s3", method="GET", path="/", operation="ListBuckets", caller=caller, region=region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                parsed_xml = parse_xml_safe(r["body"])
                buckets_container = parsed_xml.get("Buckets") or {}
                buckets = _as_list(buckets_container.get("Bucket") if isinstance(buckets_container, dict) else None)
                self._send_json({"ok": True, "buckets": buckets})
                return

            if path == "/api/s3/objects":
                bucket = qs.get("bucket", [""])[0]
                prefix = qs.get("prefix", [""])[0]
                qp = {"list-type": "2"}
                if prefix:
                    qp["prefix"] = prefix
                r = client.request(
                    service="s3",
                    method="GET",
                    path=f"/{bucket}",
                    query_params=qp,
                    operation="ListObjectsV2",
                    caller=caller,
                    region=region,
                )
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                parsed_xml = parse_xml_safe(r["body"])
                objects = _as_list(parsed_xml.get("Contents"))
                self._send_json({"ok": True, "objects": objects})
                return

            if path == "/api/s3/object":
                bucket = qs.get("bucket", [""])[0]
                key = qs.get("key", [""])[0]
                download = qs.get("download", ["0"])[0] == "1"
                r = client.request(
                    service="s3",
                    method="GET",
                    path=f"/{bucket}/{key}",
                    operation="GetObject",
                    caller=caller,
                    region=region,
                )
                if download and r["status"] == 200:
                    self.send_response(200)
                    self.send_header("Content-Type", r["headers"].get("content-type", "application/octet-stream"))
                    filename = os.path.basename(key) or "object"
                    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                    self.send_header("Content-Length", str(len(r["body"])))
                    self.end_headers()
                    self.wfile.write(r["body"])
                    return

                content_type = r["headers"].get("content-type", "")
                is_binary = False
                try:
                    text = r["body"].decode("utf-8")
                except UnicodeDecodeError:
                    is_binary = True
                    text = base64.b64encode(r["body"][:200_000]).decode("ascii")
                self._send_json(
                    {
                        "ok": r["status"] == 200,
                        "status": r["status"],
                        "reason": r["reason"],
                        "signed": r["signed"],
                        "caller": r["caller"],
                        "headers": r["headers"],
                        "content_type": content_type,
                        "size": len(r["body"]),
                        "is_binary": is_binary,
                        "content": text,
                        "error": None if r["status"] == 200 else _extract_error(r),
                    }
                )
                return

            if path == "/api/s3/bucket-access":
                bucket = qs.get("bucket", [""])[0]
                pab_r = client.request(
                    service="s3",
                    method="GET",
                    path=f"/{bucket}",
                    query_params={"publicAccessBlock": ""},
                    operation="GetPublicAccessBlock",
                    caller=caller,
                    region=region,
                )
                pol_r = client.request(
                    service="s3",
                    method="GET",
                    path=f"/{bucket}",
                    query_params={"policy": ""},
                    operation="GetBucketPolicy",
                    caller=caller,
                    region=region,
                )
                pab = parse_xml_safe(pab_r["body"]) if pab_r["status"] == 200 else None
                policy_text = pol_r["body"].decode("utf-8", errors="replace") if pol_r["status"] == 200 else None
                self._send_json(
                    {
                        "ok": True,
                        "public_access_block": pab,
                        "public_access_block_status": pab_r["status"],
                        "policy": policy_text,
                        "policy_status": pol_r["status"],
                    }
                )
                return

            # ---- IAM ----
            if path == "/api/iam/users":
                r = client.query_call("iam", "2010-05-08", {"Action": "ListUsers"}, caller, region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                res = parse_xml_safe(r["body"]).get("ListUsersResult", {})
                users_block = res.get("Users") or {}
                users = _as_list(users_block.get("member") if isinstance(users_block, dict) else None)
                session_map = {u["username"]: u["access_key_id"] for u in client.list_session_users()}
                for u in users:
                    if isinstance(u, dict):
                        u["has_session_key"] = u.get("UserName") in session_map
                self._send_json({"ok": True, "users": users, "session_users": client.list_session_users()})
                return

            if path == "/api/iam/user-details":
                username = qs.get("username", [""])[0]
                kr = client.query_call("iam", "2010-05-08", {"Action": "ListAccessKeys", "UserName": username}, caller, region)
                pr = client.query_call("iam", "2010-05-08", {"Action": "ListUserPolicies", "UserName": username}, caller, region)
                keys = []
                if kr["status"] == 200:
                    meta = parse_xml_safe(kr["body"]).get("ListAccessKeysResult", {}).get("AccessKeyMetadata") or {}
                    keys = _as_list(meta.get("member") if isinstance(meta, dict) else None)
                policy_names = []
                if pr["status"] == 200:
                    pn = parse_xml_safe(pr["body"]).get("ListUserPoliciesResult", {}).get("PolicyNames") or {}
                    policy_names = _as_list(pn.get("member") if isinstance(pn, dict) else None)
                policies = []
                for pname in policy_names:
                    gr = client.query_call(
                        "iam",
                        "2010-05-08",
                        {"Action": "GetUserPolicy", "UserName": username, "PolicyName": pname},
                        caller,
                        region,
                    )
                    doc = ""
                    if gr["status"] == 200:
                        raw_doc = parse_xml_safe(gr["body"]).get("GetUserPolicyResult", {}).get("PolicyDocument", "")
                        doc = urllib.parse.unquote(raw_doc)
                    policies.append({"name": pname, "document": doc})
                self._send_json({"ok": True, "username": username, "access_keys": keys, "inline_policies": policies})
                return

            # ---- DynamoDB ----
            if path == "/api/dynamodb/tables":
                r = client.json_call("dynamodb", "DynamoDB_20120810.ListTables", {}, caller, region=region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                data = json.loads(r["body"].decode("utf-8"))
                self._send_json({"ok": True, "tables": data.get("TableNames", [])})
                return

            if path == "/api/dynamodb/table":
                name = qs.get("name", [""])[0]
                dr = client.json_call(
                    "dynamodb", "DynamoDB_20120810.DescribeTable", {"TableName": name}, caller, region=region
                )
                sr = client.json_call(
                    "dynamodb", "DynamoDB_20120810.Scan", {"TableName": name, "Limit": 100}, caller, region=region
                )
                if dr["status"] != 200:
                    self._send_json({"ok": False, "status": dr["status"], "error": _extract_error(dr)}, 200)
                    return
                table_info = json.loads(dr["body"].decode("utf-8")).get("Table", {})
                items = json.loads(sr["body"].decode("utf-8")).get("Items", []) if sr["status"] == 200 else []
                self._send_json({"ok": True, "table": table_info, "items": items})
                return

            # ---- EC2 ----
            if path == "/api/ec2/instances":
                r = client.query_call("ec2", "2016-11-15", {"Action": "DescribeInstances"}, caller, region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)}, 200)
                    return
                res = parse_xml_safe(r["body"])
                rset = res.get("reservationSet") or {}
                reservations = _as_list(rset.get("item") if isinstance(rset, dict) else None)
                instances = []
                for resv in reservations:
                    if not isinstance(resv, dict):
                        continue
                    iset = resv.get("instancesSet") or {}
                    for inst in _as_list(iset.get("item") if isinstance(iset, dict) else None):
                        if isinstance(inst, dict):
                            instances.append(inst)
                self._send_json({"ok": True, "instances": instances})
                return

            self._send_json({"ok": False, "error": f"Unknown endpoint: {path}"}, 404)
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            body = self._read_json()
            caller, region = self._caller_and_region(qs, body)

            if path == "/api/history/clear":
                client.clear_history()
                self._send_json({"ok": True})
                return

            # ---- S3 mutations ----
            if path == "/api/s3/bucket/create":
                bucket = body["bucket"].strip()
                r = client.request(service="s3", method="PUT", path=f"/{bucket}", operation="CreateBucket", caller=caller, region=region)
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/bucket/delete":
                bucket = body["bucket"].strip()
                r = client.request(service="s3", method="DELETE", path=f"/{bucket}", operation="DeleteBucket", caller=caller, region=region)
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/object/put":
                bucket = body["bucket"].strip()
                key = body["key"].lstrip("/")
                content_type = body.get("content_type") or "application/octet-stream"
                if body.get("is_base64"):
                    raw_bytes = base64.b64decode(body.get("content", ""))
                else:
                    raw_bytes = body.get("content", "").encode("utf-8")
                r = client.request(
                    service="s3",
                    method="PUT",
                    path=f"/{bucket}/{key}",
                    operation="PutObject",
                    body=raw_bytes,
                    extra_headers={"Content-Type": content_type},
                    caller=caller,
                    region=region,
                )
                self._send_json(
                    {
                        "ok": r["status"] in (200, 204),
                        "status": r["status"],
                        "etag": r["headers"].get("etag"),
                        "error": None if r["status"] in (200, 204) else _extract_error(r),
                    }
                )
                return

            if path == "/api/s3/object/delete":
                bucket = body["bucket"].strip()
                key = body["key"].lstrip("/")
                r = client.request(service="s3", method="DELETE", path=f"/{bucket}/{key}", operation="DeleteObject", caller=caller, region=region)
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/public-access-block/delete":
                bucket = body["bucket"].strip()
                r = client.request(
                    service="s3",
                    method="DELETE",
                    path=f"/{bucket}",
                    query_params={"publicAccessBlock": ""},
                    operation="DeletePublicAccessBlock",
                    caller=caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/public-access-block/put":
                bucket = body["bucket"].strip()
                block = bool(body.get("block_all", True))
                b = "true" if block else "false"
                xml_body = (
                    '<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    f"<BlockPublicAcls>{b}</BlockPublicAcls>"
                    f"<IgnorePublicAcls>{b}</IgnorePublicAcls>"
                    f"<BlockPublicPolicy>{b}</BlockPublicPolicy>"
                    f"<RestrictPublicBuckets>{b}</RestrictPublicBuckets>"
                    "</PublicAccessBlockConfiguration>"
                ).encode("utf-8")
                r = client.request(
                    service="s3",
                    method="PUT",
                    path=f"/{bucket}",
                    query_params={"publicAccessBlock": ""},
                    operation="PutPublicAccessBlock",
                    body=xml_body,
                    extra_headers={"Content-Type": "application/xml"},
                    caller=caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/policy/put":
                bucket = body["bucket"].strip()
                policy_doc = body["policy"].encode("utf-8")
                r = client.request(
                    service="s3",
                    method="PUT",
                    path=f"/{bucket}",
                    query_params={"policy": ""},
                    operation="PutBucketPolicy",
                    body=policy_doc,
                    extra_headers={"Content-Type": "application/json"},
                    caller=caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            if path == "/api/s3/policy/delete":
                bucket = body["bucket"].strip()
                r = client.request(
                    service="s3",
                    method="DELETE",
                    path=f"/{bucket}",
                    query_params={"policy": ""},
                    operation="DeleteBucketPolicy",
                    caller=caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] in (200, 204), "status": r["status"], "error": None if r["status"] in (200, 204) else _extract_error(r)})
                return

            # ---- IAM mutations ----
            if path == "/api/iam/user/create":
                username = body["username"].strip()
                r = client.query_call("iam", "2010-05-08", {"Action": "CreateUser", "UserName": username}, caller, region)
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/iam/user/delete":
                username = body["username"].strip()
                r = client.query_call("iam", "2010-05-08", {"Action": "DeleteUser", "UserName": username}, caller, region)
                if r["status"] == 200:
                    client.unregister_session_user(username)
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/iam/access-key/create":
                username = body["username"].strip()
                r = client.query_call("iam", "2010-05-08", {"Action": "CreateAccessKey", "UserName": username}, caller, region)
                if r["status"] != 200:
                    self._send_json({"ok": False, "status": r["status"], "error": _extract_error(r)})
                    return
                ak = parse_xml_safe(r["body"]).get("CreateAccessKeyResult", {}).get("AccessKey", {})
                if ak.get("AccessKeyId") and ak.get("SecretAccessKey"):
                    client.register_session_user(username, ak["AccessKeyId"], ak["SecretAccessKey"])
                self._send_json(
                    {
                        "ok": True,
                        "status": r["status"],
                        "access_key_id": ak.get("AccessKeyId"),
                        "session_users": client.list_session_users(),
                    }
                )
                return

            if path == "/api/iam/access-key/delete":
                username = body["username"].strip()
                key_id = body["access_key_id"].strip()
                r = client.query_call(
                    "iam",
                    "2010-05-08",
                    {"Action": "DeleteAccessKey", "UserName": username, "AccessKeyId": key_id},
                    caller,
                    region,
                )
                if r["status"] == 200:
                    client.unregister_session_user(username)
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/iam/policy/put":
                r = client.query_call(
                    "iam",
                    "2010-05-08",
                    {
                        "Action": "PutUserPolicy",
                        "UserName": body["username"].strip(),
                        "PolicyName": body["policy_name"].strip(),
                        "PolicyDocument": body["policy_document"],
                    },
                    caller,
                    region,
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/iam/policy/delete":
                r = client.query_call(
                    "iam",
                    "2010-05-08",
                    {
                        "Action": "DeleteUserPolicy",
                        "UserName": body["username"].strip(),
                        "PolicyName": body["policy_name"].strip(),
                    },
                    caller,
                    region,
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            # ---- DynamoDB mutations ----
            if path == "/api/dynamodb/table/create":
                name = body["table_name"].strip()
                pk = body.get("pk_name", "id").strip() or "id"
                pk_type = body.get("pk_type", "S")
                payload = {
                    "TableName": name,
                    "BillingMode": "PAY_PER_REQUEST",
                    "AttributeDefinitions": [{"AttributeName": pk, "AttributeType": pk_type}],
                    "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}],
                }
                r = client.json_call("dynamodb", "DynamoDB_20120810.CreateTable", payload, caller, region=region)
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/dynamodb/table/delete":
                r = client.json_call(
                    "dynamodb", "DynamoDB_20120810.DeleteTable", {"TableName": body["table_name"].strip()}, caller, region=region
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/dynamodb/item/put":
                item = body["item"] if isinstance(body["item"], dict) else json.loads(body["item"])
                r = client.json_call(
                    "dynamodb",
                    "DynamoDB_20120810.PutItem",
                    {"TableName": body["table_name"].strip(), "Item": item},
                    caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/dynamodb/item/delete":
                key = body["key"] if isinstance(body["key"], dict) else json.loads(body["key"])
                r = client.json_call(
                    "dynamodb",
                    "DynamoDB_20120810.DeleteItem",
                    {"TableName": body["table_name"].strip(), "Key": key},
                    caller,
                    region=region,
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            # ---- EC2 mutations ----
            if path == "/api/ec2/run":
                params = {
                    "Action": "RunInstances",
                    "ImageId": body.get("image_id", "ami-0123456789abcdef0").strip(),
                    "InstanceType": body.get("instance_type", "t3.micro").strip(),
                    "MinCount": "1",
                    "MaxCount": "1",
                }
                tag_name = body.get("name", "").strip()
                if tag_name:
                    params["TagSpecification.1.ResourceType"] = "instance"
                    params["TagSpecification.1.Tag.1.Key"] = "Name"
                    params["TagSpecification.1.Tag.1.Value"] = tag_name
                r = client.query_call("ec2", "2016-11-15", params, caller, region)
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            if path == "/api/ec2/action":
                action_map = {
                    "start": "StartInstances",
                    "stop": "StopInstances",
                    "terminate": "TerminateInstances",
                }
                aws_action = action_map.get(body.get("action", ""))
                if not aws_action:
                    self._send_json({"ok": False, "error": "Invalid EC2 action"}, 400)
                    return
                r = client.query_call(
                    "ec2",
                    "2016-11-15",
                    {"Action": aws_action, "InstanceId.1": body["instance_id"].strip()},
                    caller,
                    region,
                )
                self._send_json({"ok": r["status"] == 200, "status": r["status"], "error": None if r["status"] == 200 else _extract_error(r)})
                return

            # ---- Raw API Playground ----
            if path == "/api/playground":
                mode = body.get("mode", "rest")
                service = body.get("service", "s3").strip()
                if mode == "query":
                    params = body.get("params") or {}
                    version = body.get("version", "2010-05-08").strip()
                    r = client.query_call(service, version, params, caller, region)
                elif mode == "json":
                    target = body.get("target", "").strip()
                    payload = body.get("payload") or {}
                    if isinstance(payload, str):
                        payload = json.loads(payload) if payload.strip() else {}
                    ct = body.get("content_type", "application/x-amz-json-1.0").strip()
                    r = client.json_call(service, target, payload, caller, content_type=ct, region=region)
                else:
                    method = body.get("method", "GET").upper()
                    req_path = body.get("path", "/")
                    if not req_path.startswith("/"):
                        req_path = "/" + req_path
                    qp = body.get("query_params") or {}
                    extra = body.get("headers") or {}
                    raw_body = body.get("body", "").encode("utf-8")
                    r = client.request(
                        service=service,
                        method=method,
                        path=req_path,
                        query_params=qp,
                        body=raw_body,
                        extra_headers=extra,
                        caller=caller,
                        region=region,
                    )
                self._send_json(
                    {
                        "ok": 200 <= r["status"] < 300,
                        "status": r["status"],
                        "reason": r["reason"],
                        "duration_ms": r["duration_ms"],
                        "signed": r["signed"],
                        "caller": r["caller"],
                        "headers": r["headers"],
                        "body": r["body"].decode("utf-8", errors="replace"),
                    }
                )
                return

            self._send_json({"ok": False, "error": f"Unknown endpoint: {path}"}, 404)
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, 500)


def main():
    httpd = ThreadingHTTPServer((AEC_HOST, AEC_PORT), ConsoleHandler)
    print(f"AEC (AWS Emulator Console) listening on http://{AEC_HOST}:{AEC_PORT}")
    print(f"Target AWS Emulator: {client.endpoint_url} (region: {client.region})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down AEC...")
        httpd.server_close()


if __name__ == "__main__":
    main()
