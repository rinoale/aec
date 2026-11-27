const state = {
  view: "overview",
  caller: "root",
  region: "us-east-1",
  selectedBucket: null,
  s3Subtab: "objects",
  selectedUser: null,
  selectedTable: null,
  selectedTablePk: "id",
  selectedTablePkType: "S",
  history: [],
  selectedLogId: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${isError ? "err" : "ok"}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4500);
}

function apiUrl(path, params = {}) {
  const sp = new URLSearchParams({ caller: state.caller, region: state.region, ...params });
  return `${path}?${sp.toString()}`;
}

async function apiGet(path, params = {}) {
  const res = await fetch(apiUrl(path, params));
  const data = await res.json();
  refreshInspector();
  return data;
}

async function apiPost(path, payload = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caller: state.caller, region: state.region, ...payload }),
  });
  const data = await res.json();
  refreshInspector();
  return data;
}

function formatBytes(n) {
  const num = Number(n || 0);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function prettyBody(text) {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (_) {}
  }
  return text;
}

function updateCallerDropdown(sessionUsers = []) {
  const sel = $("#caller-select");
  const pgSel = $("#pg-caller");
  const prev = state.caller;

  const opts = [
    `<option value="root">root (emulator)</option>`,
    `<option value="anonymous">anonymous (unsigned)</option>`,
    ...sessionUsers.map(
      (u) => `<option value="${esc(u.username)}">IAM user: ${esc(u.username)}</option>`
    ),
  ];
  sel.innerHTML = opts.join("");
  if ([...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else {
    state.caller = "root";
    sel.value = "root";
  }

  const prevPg = pgSel.value;
  pgSel.innerHTML = [
    `<option value="">(Use Active Caller)</option>`,
    ...opts,
  ].join("");
  if ([...pgSel.options].some((o) => o.value === prevPg)) {
    pgSel.value = prevPg;
  }
}

// ---- HEALTH & OVERVIEW ----
async function refreshHealth() {
  const res = await fetch("/api/health");
  const data = await res.json();
  const pill = $("#health-pill");
  if (data.ok) {
    pill.textContent = `Connected • ${data.endpoint.replace("https://", "")} (${data.latency_ms}ms)`;
    pill.className = "pill pill-ok";
  } else {
    pill.textContent = `Offline • ${data.endpoint}`;
    pill.className = "pill pill-err";
  }
  updateCallerDropdown(data.session_users || []);
  return data;
}

async function loadOverview() {
  const [health, ident, s3, iam, ddb, ec2] = await Promise.all([
    refreshHealth(),
    apiGet("/api/identity"),
    apiGet("/api/s3/buckets"),
    apiGet("/api/iam/users"),
    apiGet("/api/dynamodb/tables"),
    apiGet("/api/ec2/instances"),
  ]);

  $("#stat-s3").textContent = s3.ok ? s3.buckets.length : "Err";
  $("#stat-iam").textContent = iam.ok ? iam.users.length : "Err";
  $("#stat-ddb").textContent = ddb.ok ? ddb.tables.length : "Err";
  $("#stat-ec2").textContent = ec2.ok ? ec2.instances.length : "Err";

  $("#overview-health").innerHTML = health.ok
    ? `<table class="kv-table">
        <tr><td>Status</td><td><span class="pill pill-ok">Healthy (${esc(health.body)})</span></td></tr>
        <tr><td>Endpoint</td><td>${esc(health.endpoint)}</td></tr>
        <tr><td>Region</td><td>${esc(state.region)}</td></tr>
        <tr><td>Latency</td><td>${health.latency_ms} ms</td></tr>
      </table>`
    : `<div class="pill pill-err">Connection failed</div><p class="meta-line">${esc(health.error || "Unknown error")}</p>`;

  if (ident.ok) {
    const id = ident.identity || {};
    $("#overview-identity").innerHTML = `<table class="kv-table">
      <tr><td>Active Caller</td><td>${esc(state.caller)}</td></tr>
      <tr><td>Account</td><td>${esc(id.Account)}</td></tr>
      <tr><td>ARN</td><td>${esc(id.Arn)}</td></tr>
      <tr><td>UserId</td><td>${esc(id.UserId)}</td></tr>
    </table>`;
  } else {
    $("#overview-identity").innerHTML = `<div class="pill pill-warn">HTTP ${ident.status || "—"}</div>
      <p class="meta-line">${esc(ident.error || "Unsigned or denied caller")}</p>`;
  }
}

// ---- S3 ----
async function loadS3Buckets() {
  const data = await apiGet("/api/s3/buckets");
  const container = $("#s3-buckets-list");
  if (!data.ok) {
    container.innerHTML = `<div class="pill pill-err">${esc(data.error)}</div>`;
    return;
  }
  if (!data.buckets.length) {
    container.innerHTML = `<p class="muted small">No buckets yet.</p>`;
  } else {
    container.innerHTML = data.buckets
      .map(
        (b) => `
      <div class="list-item ${state.selectedBucket === b.Name ? "active" : ""}" data-bucket="${esc(b.Name)}">
        <span class="list-item-name">${esc(b.Name)}</span>
        <button class="btn btn-danger-outline btn-sm" data-del-bucket="${esc(b.Name)}" title="Delete empty bucket">Delete</button>
      </div>`
      )
      .join("");
  }

  $$("[data-bucket]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del-bucket]")) return;
      selectBucket(el.dataset.bucket);
    });
  });
  $$("[data-del-bucket]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = btn.dataset.delBucket;
      const r = await apiPost("/api/s3/bucket/delete", { bucket: name });
      if (r.ok) {
        toast(`Deleted bucket ${name}`);
        if (state.selectedBucket === name) {
          state.selectedBucket = null;
          renderS3Empty();
        }
        loadS3Buckets();
      } else {
        toast(r.error || "Delete failed", true);
      }
    });
  });

  if (state.selectedBucket && data.buckets.some((b) => b.Name === state.selectedBucket)) {
    loadSelectedBucket();
  }
}

function renderS3Empty() {
  $("#s3-selected-bucket-title").textContent = "Select a bucket";
  $("#s3-bucket-tabs").classList.add("hidden");
  $("#s3-bucket-empty").classList.remove("hidden");
  $("#s3-tab-objects").classList.add("hidden");
  $("#s3-tab-access").classList.add("hidden");
}

function selectBucket(name) {
  state.selectedBucket = name;
  $$("[data-bucket]").forEach((el) => el.classList.toggle("active", el.dataset.bucket === name));
  $("#s3-selected-bucket-title").textContent = `s3://${name}`;
  $("#s3-bucket-tabs").classList.remove("hidden");
  $("#s3-bucket-empty").classList.add("hidden");
  $("#s3-preview-card").classList.add("hidden");
  setS3Subtab(state.s3Subtab);
  loadSelectedBucket();
}

function setS3Subtab(tab) {
  state.s3Subtab = tab;
  $$("[data-s3tab]").forEach((b) => b.classList.toggle("active", b.dataset.s3tab === tab));
  $("#s3-tab-objects").classList.toggle("hidden", tab !== "objects");
  $("#s3-tab-access").classList.toggle("hidden", tab !== "access");
}

async function loadSelectedBucket() {
  if (!state.selectedBucket) return;
  const [objs, access] = await Promise.all([
    apiGet("/api/s3/objects", { bucket: state.selectedBucket }),
    apiGet("/api/s3/bucket-access", { bucket: state.selectedBucket }),
  ]);

  const tbody = $("#s3-objects-tbody");
  if (!objs.ok) {
    tbody.innerHTML = `<tr><td colspan="3"><span class="pill pill-err">${esc(objs.error)}</span></td></tr>`;
  } else if (!objs.objects.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Bucket is empty. Upload a file or text object above.</td></tr>`;
  } else {
    tbody.innerHTML = objs.objects
      .map(
        (o) => `
      <tr>
        <td><code>${esc(o.Key)}</code></td>
        <td>${formatBytes(o.Size)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-secondary btn-sm" data-s3-preview="${esc(o.Key)}" data-signed="1">Preview</button>
            <button class="btn btn-accent btn-sm" data-s3-preview="${esc(o.Key)}" data-signed="0">Test Public GET</button>
            <a class="btn btn-secondary btn-sm" href="${apiUrl("/api/s3/object", { bucket: state.selectedBucket, key: o.Key, download: "1" })}">Download</a>
            <button class="btn btn-danger-outline btn-sm" data-s3-del="${esc(o.Key)}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join("");

    $$("[data-s3-preview]").forEach((btn) => {
      btn.addEventListener("click", () =>
        previewObject(btn.dataset.s3Preview, btn.dataset.signed === "1")
      );
    });
    $$("[data-s3-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = await apiPost("/api/s3/object/delete", {
          bucket: state.selectedBucket,
          key: btn.dataset.s3Del,
        });
        if (r.ok) {
          toast(`Deleted ${btn.dataset.s3Del}`);
          loadSelectedBucket();
        } else {
          toast(r.error || "Delete failed", true);
        }
      });
    });
  }

  // Public access block & policy
  const pabStatus = $("#s3-pab-status");
  if (access.public_access_block_status === 200 && access.public_access_block) {
    const p = access.public_access_block;
    const anyBlocked = Object.values(p).some((v) => String(v).toLowerCase() === "true");
    pabStatus.innerHTML = anyBlocked
      ? `<span class="pill pill-warn">Active</span> BlockPublicAcls=${esc(p.BlockPublicAcls)}, BlockPublicPolicy=${esc(p.BlockPublicPolicy)}, RestrictPublicBuckets=${esc(p.RestrictPublicBuckets)}`
      : `<span class="pill pill-ok">Configured (all false)</span>`;
  } else {
    pabStatus.innerHTML = `<span class="pill pill-ok">Disabled (No PublicAccessBlock)</span>`;
  }

  $("#s3-policy-editor").value = access.policy ? prettyBody(access.policy) : "";
}

async function previewObject(key, useActiveCaller) {
  const caller = useActiveCaller ? state.caller : "anonymous";
  const r = await apiGet("/api/s3/object", {
    bucket: state.selectedBucket,
    key,
    caller,
  });
  const card = $("#s3-preview-card");
  card.classList.remove("hidden");
  $("#s3-preview-title").textContent = `${useActiveCaller ? "Signed/Active" : "Anonymous Public"} GET s3://${state.selectedBucket}/${key}`;
  const badge = $("#s3-preview-badge");
  badge.textContent = `${r.status} ${r.reason} (${r.signed ? r.caller : "UNSIGNED"})`;
  badge.className = `pill ${r.ok ? "pill-ok" : "pill-err"}`;
  $("#s3-preview-meta").textContent = `Content-Type: ${r.content_type || "—"} | Size: ${formatBytes(r.size)} | ETag: ${r.headers?.etag || "—"}`;
  if (r.is_binary) {
    $("#s3-preview-body").textContent = `[Binary data: ${formatBytes(r.size)} — use Download button]`;
  } else {
    $("#s3-preview-body").textContent = r.ok ? r.content : (r.error || r.content);
  }
}

async function uploadFileObj(file) {
  if (!state.selectedBucket || !file) return;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const r = await apiPost("/api/s3/object/put", {
    bucket: state.selectedBucket,
    key: file.name,
    content_type: file.type || "application/octet-stream",
    content: b64,
    is_base64: true,
  });
  if (r.ok) {
    toast(`Uploaded ${file.name} (${formatBytes(file.size)})`);
    loadSelectedBucket();
  } else {
    toast(r.error || "Upload failed", true);
  }
}

// ---- IAM ----
async function loadIamUsers() {
  const data = await apiGet("/api/iam/users");
  const container = $("#iam-users-list");
  if (!data.ok) {
    container.innerHTML = `<div class="pill pill-err">${esc(data.error)}</div>`;
    return;
  }
  updateCallerDropdown(data.session_users || []);
  if (!data.users.length) {
    container.innerHTML = `<p class="muted small">No IAM users yet.</p>`;
  } else {
    container.innerHTML = data.users
      .map(
        (u) => `
      <div class="list-item ${state.selectedUser === u.UserName ? "active" : ""}" data-iam-user="${esc(u.UserName)}">
        <div>
          <div class="list-item-name">${esc(u.UserName)}</div>
          <div class="small muted">${u.has_session_key ? "Session key ready" : "No session key"}</div>
        </div>
        <button class="btn btn-danger-outline btn-sm" data-del-user="${esc(u.UserName)}">Delete</button>
      </div>`
      )
      .join("");
  }

  $$("[data-iam-user]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del-user]")) return;
      selectIamUser(el.dataset.iamUser);
    });
  });
  $$("[data-del-user]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = btn.dataset.delUser;
      const r = await apiPost("/api/iam/user/delete", { username: name });
      if (r.ok) {
        toast(`Deleted user ${name}`);
        if (state.selectedUser === name) {
          state.selectedUser = null;
          $("#iam-user-empty").classList.remove("hidden");
          $("#iam-user-detail").classList.add("hidden");
          $("#iam-act-as-btn").classList.add("hidden");
          $("#iam-selected-user-title").textContent = "Select an IAM user";
        }
        loadIamUsers();
      } else {
        toast(r.error || "Delete failed (remove keys/policies first)", true);
      }
    });
  });

  if (state.selectedUser && data.users.some((u) => u.UserName === state.selectedUser)) {
    loadSelectedIamUser();
  }
}

function selectIamUser(username) {
  state.selectedUser = username;
  $$("[data-iam-user]").forEach((el) => el.classList.toggle("active", el.dataset.iamUser === username));
  $("#iam-selected-user-title").textContent = `IAM User: ${username}`;
  $("#iam-user-empty").classList.add("hidden");
  $("#iam-user-detail").classList.remove("hidden");
  loadSelectedIamUser();
}

async function loadSelectedIamUser() {
  if (!state.selectedUser) return;
  const data = await apiGet("/api/iam/user-details", { username: state.selectedUser });
  const keysList = $("#iam-keys-list");
  if (!data.access_keys.length) {
    keysList.innerHTML = `<p class="muted small">No access keys. Click "Create Access Key" to test as this user.</p>`;
  } else {
    keysList.innerHTML = data.access_keys
      .map(
        (k) => `
      <div class="list-item">
        <div>
          <code>${esc(k.AccessKeyId)}</code>
          <span class="pill pill-ok">${esc(k.Status)}</span>
        </div>
        <button class="btn btn-danger-outline btn-sm" data-del-key="${esc(k.AccessKeyId)}">Delete Key</button>
      </div>`
      )
      .join("");
    $$("[data-del-key]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = await apiPost("/api/iam/access-key/delete", {
          username: state.selectedUser,
          access_key_id: btn.dataset.delKey,
        });
        if (r.ok) {
          toast("Deleted access key");
          loadIamUsers();
        } else {
          toast(r.error || "Failed", true);
        }
      });
    });
  }

  const hasSessionKey = [...$("#caller-select").options].some((o) => o.value === state.selectedUser);
  const actBtn = $("#iam-act-as-btn");
  actBtn.classList.toggle("hidden", !hasSessionKey);
  actBtn.textContent = state.caller === state.selectedUser ? `Currently acting as ${state.selectedUser}` : `Act as ${state.selectedUser}`;

  const polList = $("#iam-policies-list");
  if (!data.inline_policies.length) {
    polList.innerHTML = `<p class="muted small">No inline policies attached (all actions denied by default).</p>`;
  } else {
    polList.innerHTML = data.inline_policies
      .map(
        (p) => `
      <div class="subpanel">
        <div class="row-between">
          <strong>${esc(p.name)}</strong>
          <button class="btn btn-danger-outline btn-sm" data-del-pol="${esc(p.name)}">Delete</button>
        </div>
        <pre class="code-block small-block">${esc(prettyBody(p.document))}</pre>
      </div>`
      )
      .join("");
    $$("[data-del-pol]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = await apiPost("/api/iam/policy/delete", {
          username: state.selectedUser,
          policy_name: btn.dataset.delPol,
        });
        if (r.ok) {
          toast(`Deleted policy ${btn.dataset.delPol}`);
          loadSelectedIamUser();
        } else {
          toast(r.error || "Delete failed", true);
        }
      });
    });
  }
}

// ---- DYNAMODB ----
async function loadDdbTables() {
  const data = await apiGet("/api/dynamodb/tables");
  const container = $("#ddb-tables-list");
  if (!data.ok) {
    container.innerHTML = `<div class="pill pill-err">${esc(data.error)}</div>`;
    return;
  }
  if (!data.tables.length) {
    container.innerHTML = `<p class="muted small">No tables yet.</p>`;
  } else {
    container.innerHTML = data.tables
      .map(
        (t) => `
      <div class="list-item ${state.selectedTable === t ? "active" : ""}" data-ddb-table="${esc(t)}">
        <span class="list-item-name">${esc(t)}</span>
        <button class="btn btn-danger-outline btn-sm" data-del-table="${esc(t)}">Delete</button>
      </div>`
      )
      .join("");
  }

  $$("[data-ddb-table]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del-table]")) return;
      selectDdbTable(el.dataset.ddbTable);
    });
  });
  $$("[data-del-table]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = btn.dataset.delTable;
      const r = await apiPost("/api/dynamodb/table/delete", { table_name: name });
      if (r.ok) {
        toast(`Deleted table ${name}`);
        if (state.selectedTable === name) {
          state.selectedTable = null;
          $("#ddb-table-empty").classList.remove("hidden");
          $("#ddb-table-detail").classList.add("hidden");
        }
        loadDdbTables();
      } else {
        toast(r.error || "Delete failed", true);
      }
    });
  });

  if (state.selectedTable && data.tables.includes(state.selectedTable)) {
    loadSelectedDdbTable();
  }
}

function selectDdbTable(name) {
  state.selectedTable = name;
  $$("[data-ddb-table]").forEach((el) => el.classList.toggle("active", el.dataset.ddbTable === name));
  $("#ddb-selected-table-title").textContent = `Table: ${name}`;
  $("#ddb-table-empty").classList.add("hidden");
  $("#ddb-table-detail").classList.remove("hidden");
  loadSelectedDdbTable();
}

async function loadSelectedDdbTable() {
  if (!state.selectedTable) return;
  const data = await apiGet("/api/dynamodb/table", { name: state.selectedTable });
  if (!data.ok) {
    toast(data.error || "Failed to load table", true);
    return;
  }
  const t = data.table || {};
  const hashKey = (t.KeySchema || []).find((k) => k.KeyType === "HASH");
  const pkName = hashKey ? hashKey.AttributeName : "id";
  const attrDef = (t.AttributeDefinitions || []).find((a) => a.AttributeName === pkName);
  const pkType = attrDef ? attrDef.AttributeType : "S";
  state.selectedTablePk = pkName;
  state.selectedTablePkType = pkType;

  $("#ddb-table-meta").textContent = `Status: ${t.TableStatus || "—"} | Partition Key: ${pkName} (${pkType}) | Items: ${data.items.length}`;
  if (!$("#ddb-item-json").value.trim()) {
    const sample = { [pkName]: { [pkType]: pkType === "N" ? "1" : "item-1" }, name: { S: "Sample" } };
    $("#ddb-item-json").value = JSON.stringify(sample, null, 2);
  }

  const tbody = $("#ddb-items-tbody");
  if (!data.items.length) {
    tbody.innerHTML = `<tr><td colspan="2" class="muted">No items in this table yet.</td></tr>`;
  } else {
    tbody.innerHTML = data.items
      .map(
        (item, idx) => `
      <tr>
        <td><pre class="code-block small-block">${esc(JSON.stringify(item, null, 2))}</pre></td>
        <td><button class="btn btn-danger-outline btn-sm" data-ddb-del-idx="${idx}">Delete</button></td>
      </tr>`
      )
      .join("");
    $$("[data-ddb-del-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = data.items[Number(btn.dataset.ddbDelIdx)];
        const key = { [pkName]: item[pkName] };
        const r = await apiPost("/api/dynamodb/item/delete", {
          table_name: state.selectedTable,
          key,
        });
        if (r.ok) {
          toast("Deleted item");
          loadSelectedDdbTable();
        } else {
          toast(r.error || "Delete failed", true);
        }
      });
    });
  }
}

// ---- EC2 ----
async function loadEc2() {
  const data = await apiGet("/api/ec2/instances");
  const tbody = $("#ec2-instances-tbody");
  if (!data.ok) {
    tbody.innerHTML = `<tr><td colspan="6"><span class="pill pill-err">${esc(data.error)}</span></td></tr>`;
    return;
  }
  if (!data.instances.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No EC2 instances yet. Launch one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.instances
    .map((inst) => {
      const stateName = inst.instanceState?.name || "unknown";
      const pillCls =
        stateName === "running"
          ? "pill-ok"
          : stateName === "terminated"
          ? "pill-err"
          : "pill-warn";
      let nameTag = "—";
      const tags = inst.tagSet?.item;
      const tagArr = Array.isArray(tags) ? tags : tags ? [tags] : [];
      const found = tagArr.find((t) => t.key === "Name");
      if (found) nameTag = found.value;
      return `
      <tr>
        <td><code>${esc(inst.instanceId)}</code></td>
        <td>${esc(nameTag)}</td>
        <td><span class="pill ${pillCls}">${esc(stateName)}</span></td>
        <td>${esc(inst.instanceType)}</td>
        <td><code>${esc(inst.privateIpAddress || "—")}</code></td>
        <td>
          <div class="btn-group">
            <button class="btn btn-secondary btn-sm" data-ec2-act="start" data-ec2-id="${esc(inst.instanceId)}">Start</button>
            <button class="btn btn-secondary btn-sm" data-ec2-act="stop" data-ec2-id="${esc(inst.instanceId)}">Stop</button>
            <button class="btn btn-danger-outline btn-sm" data-ec2-act="terminate" data-ec2-id="${esc(inst.instanceId)}">Terminate</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  $$("[data-ec2-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = await apiPost("/api/ec2/action", {
        instance_id: btn.dataset.ec2Id,
        action: btn.dataset.ec2Act,
      });
      if (r.ok) {
        toast(`${btn.dataset.ec2Act} requested for ${btn.dataset.ec2Id}`);
        loadEc2();
      } else {
        toast(r.error || "Action failed", true);
      }
    });
  });
}

// ---- PLAYGROUND ----
function updatePlaygroundFields() {
  const mode = $("#pg-mode").value;
  $("#pg-rest-fields").classList.toggle("hidden", mode !== "rest");
  $("#pg-query-fields").classList.toggle("hidden", mode !== "query");
  $("#pg-json-fields").classList.toggle("hidden", mode !== "json");
}

function applyPlaygroundPreset(key) {
  const presets = {
    "sts-whoami": { mode: "query", service: "sts", version: "2011-06-15", action: "GetCallerIdentity", body: "", caller: "" },
    "s3-list": { mode: "rest", service: "s3", method: "GET", path: "/", query: "", body: "", caller: "" },
    "s3-public": { mode: "rest", service: "s3", method: "GET", path: "/demo-public-bucket/hello.txt", query: "", body: "", caller: "anonymous" },
    "iam-users": { mode: "query", service: "iam", version: "2010-05-08", action: "ListUsers", body: "", caller: "" },
    "ddb-tables": { mode: "json", service: "dynamodb", target: "DynamoDB_20120810.ListTables", ct: "application/x-amz-json-1.0", body: "{}", caller: "" },
    "sqs-queues": { mode: "json", service: "sqs", target: "AmazonSQS.ListQueues", ct: "application/x-amz-json-1.0", body: "{}", caller: "" },
    "sm-list": { mode: "json", service: "secretsmanager", target: "secretsmanager.ListSecrets", ct: "application/x-amz-json-1.1", body: "{}", caller: "" },
  };
  const p = presets[key];
  if (!p) return;
  $("#pg-mode").value = p.mode;
  $("#pg-service").value = p.service;
  $("#pg-caller").value = p.caller;
  if (p.method) $("#pg-method").value = p.method;
  if (p.path !== undefined) $("#pg-path").value = p.path;
  if (p.query !== undefined) $("#pg-query").value = p.query;
  if (p.version) $("#pg-version").value = p.version;
  if (p.action) $("#pg-action").value = p.action;
  if (p.target) $("#pg-target").value = p.target;
  if (p.ct) $("#pg-content-type").value = p.ct;
  $("#pg-body").value = p.body || "";
  updatePlaygroundFields();
}

// ---- API INSPECTOR ----
async function refreshInspector() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    state.history = data.items || [];
    $("#inspector-count").textContent = state.history.length;
    renderInspectorList();
  } catch (_) {}
}

function renderInspectorList() {
  const list = $("#inspector-list");
  if (!state.history.length) {
    list.innerHTML = `<div style="padding:14px" class="muted">No API calls recorded yet.</div>`;
    return;
  }
  list.innerHTML = state.history
    .map((h) => {
      const cls = h.status >= 200 && h.status < 300 ? "pill-ok" : "pill-err";
      return `
      <div class="insp-row ${state.selectedLogId === h.id ? "active" : ""}" data-log-id="${h.id}">
        <span class="pill ${cls}">${h.status}</span>
        <span>${esc(h.service)}</span>
        <span class="insp-op" title="${esc(h.operation)}">${esc(h.operation)} <span class="muted">(${esc(h.caller)})</span></span>
        <span class="muted">${h.duration_ms}ms</span>
      </div>`;
    })
    .join("");

  $$("[data-log-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedLogId = Number(row.dataset.logId);
      renderInspectorList();
      renderInspectorDetail();
    });
  });
}

function renderInspectorDetail() {
  const item = state.history.find((h) => h.id === state.selectedLogId);
  if (!item) return;
  $("#inspector-detail").innerHTML = `
    <div><strong>${esc(item.method)} ${esc(item.target)}</strong> — ${item.status} ${esc(item.reason)} (${item.duration_ms}ms) • Caller: <strong>${esc(item.caller)}</strong> (${item.signed ? "SigV4 signed" : "UNSIGNED"}) • ${esc(item.timestamp)}</div>
    <div style="margin-top:8px;color:#94a3b8">Request Headers</div>
    <pre>${esc(JSON.stringify(item.request_headers, null, 2))}</pre>
    ${item.request_body ? `<div style="color:#94a3b8">Request Body</div><pre>${esc(prettyBody(item.request_body))}</pre>` : ""}
    <div style="color:#94a3b8">Response Headers</div>
    <pre>${esc(JSON.stringify(item.response_headers, null, 2))}</pre>
    <div style="color:#94a3b8">Response Body</div>
    <pre>${esc(prettyBody(item.response_body || "(empty)"))}</pre>
  `;
}

// ---- NAVIGATION & EVENTS ----
function switchView(view) {
  state.view = view;
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  refreshCurrentView();
}

function refreshCurrentView() {
  if (state.view === "overview") loadOverview();
  else if (state.view === "s3") loadS3Buckets();
  else if (state.view === "iam") loadIamUsers();
  else if (state.view === "dynamodb") loadDdbTables();
  else if (state.view === "ec2") loadEc2();
}

function bindEvents() {
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $$("[data-jump]").forEach((card) => card.addEventListener("click", () => switchView(card.dataset.jump)));

  $("#caller-select").addEventListener("change", (e) => {
    state.caller = e.target.value;
    toast(`Active caller switched to ${state.caller}`);
    refreshCurrentView();
  });
  $("#region-select").addEventListener("change", (e) => {
    state.region = e.target.value;
    refreshCurrentView();
  });
  $("#refresh-btn").addEventListener("click", refreshCurrentView);

  // Inspector drawer
  $("#inspector-toggle-btn").addEventListener("click", () => {
    $("#inspector-drawer").classList.toggle("hidden");
    refreshInspector();
  });
  $("#inspector-close-btn").addEventListener("click", () => $("#inspector-drawer").classList.add("hidden"));
  $("#inspector-clear-btn").addEventListener("click", async () => {
    await apiPost("/api/history/clear");
    state.selectedLogId = null;
    $("#inspector-detail").innerHTML = `<div class="muted">History cleared.</div>`;
    refreshInspector();
  });

  // S3
  $("#s3-create-bucket-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bucket = $("#s3-new-bucket").value.trim();
    const r = await apiPost("/api/s3/bucket/create", { bucket });
    if (r.ok) {
      $("#s3-new-bucket").value = "";
      toast(`Created bucket ${bucket}`);
      state.selectedBucket = bucket;
      await loadS3Buckets();
      selectBucket(bucket);
    } else {
      toast(r.error || "Create bucket failed", true);
    }
  });

  $$("[data-s3tab]").forEach((btn) => btn.addEventListener("click", () => setS3Subtab(btn.dataset.s3tab)));

  const dropZone = $("#s3-drop-zone");
  const fileInput = $("#s3-file-input");
  fileInput.addEventListener("change", async () => {
    for (const f of fileInput.files) await uploadFileObj(f);
    fileInput.value = "";
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    for (const f of e.dataTransfer.files) await uploadFileObj(f);
  });

  $("#s3-text-upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("#s3-obj-key").value.trim();
    const content_type = $("#s3-obj-ctype").value.trim() || "text/plain";
    const content = $("#s3-obj-content").value;
    const r = await apiPost("/api/s3/object/put", {
      bucket: state.selectedBucket,
      key,
      content_type,
      content,
    });
    if (r.ok) {
      toast(`Uploaded ${key}`);
      loadSelectedBucket();
    } else {
      toast(r.error || "PutObject failed", true);
    }
  });

  $("#s3-pab-disable-btn").addEventListener("click", async () => {
    const r = await apiPost("/api/s3/public-access-block/delete", { bucket: state.selectedBucket });
    if (r.ok) {
      toast("Disabled Block Public Access");
      loadSelectedBucket();
    } else {
      toast(r.error || "Failed", true);
    }
  });

  $("#s3-pab-enable-btn").addEventListener("click", async () => {
    const r = await apiPost("/api/s3/public-access-block/put", { bucket: state.selectedBucket, block_all: true });
    if (r.ok) {
      toast("Enabled Block All Public Access");
      loadSelectedBucket();
    } else {
      toast(r.error || "Failed", true);
    }
  });

  $("#s3-policy-preset-btn").addEventListener("click", () => {
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadGetObject",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${state.selectedBucket}/*`,
        },
      ],
    };
    $("#s3-policy-editor").value = JSON.stringify(policy, null, 2);
  });

  $("#s3-policy-save-btn").addEventListener("click", async () => {
    const policy = $("#s3-policy-editor").value.trim();
    const r = await apiPost("/api/s3/policy/put", { bucket: state.selectedBucket, policy });
    if (r.ok) {
      toast("Saved bucket policy");
      loadSelectedBucket();
    } else {
      toast(r.error || "PutBucketPolicy failed", true);
    }
  });

  $("#s3-policy-delete-btn").addEventListener("click", async () => {
    const r = await apiPost("/api/s3/policy/delete", { bucket: state.selectedBucket });
    if (r.ok) {
      toast("Deleted bucket policy");
      loadSelectedBucket();
    } else {
      toast(r.error || "DeleteBucketPolicy failed", true);
    }
  });

  // IAM
  $("#iam-create-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#iam-new-user").value.trim();
    const r = await apiPost("/api/iam/user/create", { username });
    if (r.ok) {
      $("#iam-new-user").value = "";
      toast(`Created IAM user ${username}`);
      state.selectedUser = username;
      await loadIamUsers();
      selectIamUser(username);
    } else {
      toast(r.error || "CreateUser failed", true);
    }
  });

  $("#iam-create-key-btn").addEventListener("click", async () => {
    const r = await apiPost("/api/iam/access-key/create", { username: state.selectedUser });
    if (r.ok) {
      updateCallerDropdown(r.session_users || []);
      toast(`Created access key ${r.access_key_id} (stored in local server session)`);
      loadIamUsers();
    } else {
      toast(r.error || "CreateAccessKey failed", true);
    }
  });

  $("#iam-act-as-btn").addEventListener("click", () => {
    state.caller = state.selectedUser;
    $("#caller-select").value = state.selectedUser;
    toast(`Active caller switched to IAM user: ${state.selectedUser}`);
    loadSelectedIamUser();
  });

  $("#iam-policy-preset").addEventListener("change", (e) => {
    const presets = {
      "s3-read": {
        name: "S3ReadOnly",
        doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket", "s3:ListAllMyBuckets"], Resource: "*" }] },
      },
      "s3-full": {
        name: "S3FullAccess",
        doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }] },
      },
      "ddb-read": {
        name: "DynamoDBReadOnly",
        doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:ListTables", "dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:Query"], Resource: "*" }] },
      },
      "deny-s3": {
        name: "ExplicitDenyS3",
        doc: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:*", Resource: "*" }] },
      },
    };
    const p = presets[e.target.value];
    if (p) {
      $("#iam-policy-name").value = p.name;
      $("#iam-policy-doc").value = JSON.stringify(p.doc, null, 2);
    }
    e.target.value = "";
  });

  $("#iam-policy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await apiPost("/api/iam/policy/put", {
      username: state.selectedUser,
      policy_name: $("#iam-policy-name").value.trim(),
      policy_document: $("#iam-policy-doc").value.trim(),
    });
    if (r.ok) {
      toast("Attached inline policy");
      loadSelectedIamUser();
    } else {
      toast(r.error || "PutUserPolicy failed", true);
    }
  });

  // DynamoDB
  $("#ddb-create-table-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const table_name = $("#ddb-table-name").value.trim();
    const r = await apiPost("/api/dynamodb/table/create", {
      table_name,
      pk_name: $("#ddb-pk-name").value.trim(),
      pk_type: $("#ddb-pk-type").value,
    });
    if (r.ok) {
      $("#ddb-table-name").value = "";
      $("#ddb-item-json").value = "";
      toast(`Created table ${table_name}`);
      state.selectedTable = table_name;
      await loadDdbTables();
      selectDdbTable(table_name);
    } else {
      toast(r.error || "CreateTable failed", true);
    }
  });

  $("#ddb-put-item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const item = JSON.parse($("#ddb-item-json").value);
      const r = await apiPost("/api/dynamodb/item/put", {
        table_name: state.selectedTable,
        item,
      });
      if (r.ok) {
        toast("PutItem succeeded");
        loadSelectedDdbTable();
      } else {
        toast(r.error || "PutItem failed", true);
      }
    } catch (err) {
      toast(`Invalid JSON: ${err.message}`, true);
    }
  });

  // EC2
  $("#ec2-run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await apiPost("/api/ec2/run", {
      name: $("#ec2-name").value.trim(),
      instance_type: $("#ec2-type").value.trim(),
      image_id: $("#ec2-ami").value.trim(),
    });
    if (r.ok) {
      $("#ec2-name").value = "";
      toast("Launched EC2 instance");
      loadEc2();
    } else {
      toast(r.error || "RunInstances failed", true);
    }
  });

  // Playground
  $("#pg-mode").addEventListener("change", updatePlaygroundFields);
  $("#pg-preset").addEventListener("change", (e) => {
    applyPlaygroundPreset(e.target.value);
    e.target.value = "";
  });
  $("#pg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = $("#pg-mode").value;
    const payload = {
      mode,
      service: $("#pg-service").value.trim(),
      caller: $("#pg-caller").value || state.caller,
    };
    try {
      if (mode === "rest") {
        payload.method = $("#pg-method").value;
        payload.path = $("#pg-path").value.trim() || "/";
        const q = $("#pg-query").value.trim();
        payload.query_params = q ? JSON.parse(q) : {};
        payload.body = $("#pg-body").value;
      } else if (mode === "query") {
        payload.version = $("#pg-version").value.trim();
        const extra = $("#pg-extra-params").value.trim();
        payload.params = { Action: $("#pg-action").value.trim(), ...(extra ? JSON.parse(extra) : {}) };
      } else {
        payload.target = $("#pg-target").value.trim();
        payload.content_type = $("#pg-content-type").value.trim();
        const raw = $("#pg-body").value.trim();
        payload.payload = raw ? JSON.parse(raw) : {};
      }
    } catch (err) {
      toast(`Invalid JSON input: ${err.message}`, true);
      return;
    }

    const r = await apiPost("/api/playground", payload);
    const badge = $("#pg-status-badge");
    badge.textContent = `${r.status || "ERR"} ${r.reason || ""}`;
    badge.className = `pill ${r.ok ? "pill-ok" : "pill-err"}`;
    $("#pg-meta").textContent = `Caller: ${r.caller || "—"} (${r.signed ? "SigV4" : "UNSIGNED"}) | Latency: ${r.duration_ms ?? "—"} ms`;
    const hdrEl = $("#pg-resp-headers");
    hdrEl.classList.remove("hidden");
    hdrEl.textContent = JSON.stringify(r.headers || {}, null, 2);
    $("#pg-resp-body").textContent = prettyBody(r.body || r.error || "(empty)");
  });
}

bindEvents();
updatePlaygroundFields();
loadOverview();
setInterval(refreshHealth, 15000);
