const state = {
  tabId: null,
  context: null,
  describe: null,
  metadataError: null,
  pageFields: [],
  pageRecord: null,
  pageRecordLoading: false,
  pageRecordError: null,
  record: null,

  selectedField: null,
  inspectorOn: false,
  activeAction: null,
  pending: new Map()
};

const FALLBACK_FIELDS = {
  Opportunity: [
    ["Name", "Name", "String", true], ["Stage Name", "StageName", "Picklist", true],
    ["Amount", "Amount", "Currency", false], ["Close Date", "CloseDate", "Date", true],
    ["Account Name", "AccountId", "Lookup(Account)", false], ["Opportunity Owner", "OwnerId", "Lookup(User)", true]
  ],
  Account: [["Account Name", "Name", "String", true], ["Account Owner", "OwnerId", "Lookup(User)", true], ["Phone", "Phone", "Phone", false], ["Website", "Website", "URL", false]],
  Contact: [["Name", "Name", "String", false], ["Account Name", "AccountId", "Lookup(Account)", false], ["Email", "Email", "Email", false], ["Phone", "Phone", "Phone", false]]
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const compactName = (name = "") => name.replace(/\s+/g, " ").trim();
const STANDARD_PAGE_FIELDS = new Set(["Name", "OwnerId", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "RecordTypeId", "CurrencyIsoCode"]);
function isUsablePageField(name) {
  if (typeof name !== "string" || name === state.context?.objectName) return false;
  return /^(?:[A-Za-z][A-Za-z0-9_]*__)+c$/.test(name) || STANDARD_PAGE_FIELDS.has(name);
}
function displayPageField(name) {
  const parts = name.split("__");
  const visibleName = parts.length >= 3 ? parts.slice(1, -1).join("_") : name;
  return visibleName.replace(/_/g, " ");
}
function pageFieldForLabel(label) {
  const target = compactName(label).toLowerCase().replace(/[^a-z0-9]/g, "");
  return state.pageFields.find((name) => {
    const parts = name.split("__");
    const visibleName = parts.length >= 3 ? parts.slice(1, -1).join("_") : name;
    const candidate = visibleName.toLowerCase().replace(/[^a-z0-9]/g, "");
    return candidate === target || candidate.endsWith(target);
  }) || null;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

async function copy(value, message = "Copied to clipboard") {
  try { await navigator.clipboard.writeText(value); toast(message); } catch { toast("Clipboard access was unavailable."); }
}

function showTool(content) {
  $("#empty-state").hidden = true;
  const tool = $("#tool-content");
  tool.hidden = false;
  tool.innerHTML = content;
}

function noRecordMessage(action) {
  showTool(`<div class="tool-title"><div><h3>${escapeHtml(action)}</h3><p>Open a Salesforce record first.</p></div></div><div class="notice">This tool needs a record URL in the format <code>/lightning/r/Object/RecordId/view</code>.</div>`);
}

function updateContext(context) {
  state.context = context;
  const hasRecord = Boolean(context?.recordId && context?.objectName);
  $("#record-context").hidden = !hasRecord;
  $("#title").textContent = hasRecord ? `${context.objectName} Helper` : "Context Helper";
  $("#subtitle").textContent = hasRecord ? `Ready on ${context.host}` : "Open a Salesforce record to begin.";
  if (hasRecord) {
    $("#object-badge").textContent = `Object: ${context.objectName}`;
    $("#record-id").textContent = context.recordId;
    $("#record-id").onclick = () => copy(context.recordId, "Record ID copied");
    $("#empty-state").innerHTML = `<div class="empty-icon">✦</div><p><strong>${escapeHtml(context.objectName)}</strong> detected. Choose a quick action above.</p>`;
    state.pageFields = [];
    state.pageRecord = null;
    state.pageRecordLoading = false;
    state.pageRecordError = null;
    requestDescribe().catch(() => {});

    loadPageFields().catch(() => {});
  }
}

function fieldCandidates() {
  if (state.describe?.fields) return state.describe.fields.filter((field) => field.name !== "Id");
  return [];
}

function fieldForSelection(selection) {
  const fields = fieldCandidates();
  const normalized = compactName(selection?.label).toLowerCase();
  const pageName = pageFieldForLabel(selection?.label || "");
  return fields.find((field) => field.name === selection?.apiName)
    || fields.find((field) => compactName(field.label).toLowerCase() === normalized)
    || fields.find((field) => compactName(field.label).toLowerCase().includes(normalized) || normalized.includes(compactName(field.label).toLowerCase()))
    || (pageName ? { name: pageName, label: selection.label, type: "Unknown (page layout)", nillable: true } : null)
    || (selection?.apiName ? { name: selection.apiName, label: selection.label, type: "unknown", nillable: true } : null);
}

function renderField(field, clickedLabel) {
  if (!field) {
    showTool(`<div class="tool-title"><div><h3>Field Inspector</h3><p>Click a field label on the Salesforce page.</p></div><span class="pill">Inspector on</span></div><div class="notice">I couldn't resolve “${escapeHtml(clickedLabel || "that item")}" as a field. Salesforce components vary by page; try the field label itself, or load object metadata first.</div>`);
    return;
  }
  const type = field.type === "reference" ? `Lookup(${field.referenceTo?.join(", ") || "record"})` : field.type || "Unknown";
  const object = state.context?.objectName || field.sobjectType || "—";
  showTool(`
    <div class="tool-title"><div><h3>Field Inspector</h3><p>${escapeHtml(field.label || clickedLabel || field.name)}</p></div><span class="pill">${state.describe ? "Metadata loaded" : "Page estimate"}</span></div>
    <dl class="detail-list">
      <div class="detail-row"><dt>Label</dt><dd>${escapeHtml(field.label || clickedLabel || "—")}</dd></div>
      <div class="detail-row"><dt>API Name</dt><dd>${escapeHtml(field.name)}</dd></div>
      <div class="detail-row"><dt>Object</dt><dd>${escapeHtml(object)}</dd></div>
      <div class="detail-row"><dt>Type</dt><dd>${escapeHtml(type)}</dd></div>
      <div class="detail-row"><dt>Required</dt><dd>${field.nillable === false ? "Yes" : "No"}</dd></div>
    </dl>
    <div class="button-row">
      <button data-copy="${escapeHtml(field.name)}">Copy API Name</button>
      <button data-copy-soql="${escapeHtml(field.name)}">Copy SOQL</button>
      <button data-open-field="${escapeHtml(field.name)}">Open Field</button>
    </div>`);
}

function baseQuery(fields) {
  const context = state.context;
  const selected = fields.length ? fields : ["Id", "Name"];
  return `SELECT ${selected.join(",\n       ")}\nFROM ${context.objectName}\nWHERE Id = '${context.recordId}'`;
}

function defaultQueryFields() {
  if (state.pageFields.length) return ["Id", ...state.pageFields.filter((name) => name !== "Id").slice(0, 30)];
  if (!state.describe?.fields) return ["Id"];
  const nameField = state.describe.fields.find((field) => field.nameField && field.queryable !== false)?.name;
  const usable = state.describe.fields
    .filter((field) => field.name !== "Id" && field.queryable !== false && !["address", "location", "base64"].includes(field.type))
    .slice(0, 8)
    .map((field) => field.name);
  return ["Id", ...(nameField ? [nameField] : []), ...usable.filter((name) => name !== nameField)].slice(0, 10);
}

function renderSoql() {
  if (!state.context?.recordId) return noRecordMessage("Generate SOQL");
  const query = baseQuery(defaultQueryFields());
  showTool(`<div class="tool-title"><div><h3>Generate SOQL</h3><p>A record-targeted query based on ${escapeHtml(state.context.objectName)}.</p></div><span class="pill">Ready</span></div><pre>${escapeHtml(query)}</pre><div class="button-row"><button class="primary-button" data-copy-query>Copy Query</button><button data-action="api">Inspect REST API</button></div>`);
}

function inspectorContent() {
  const options = state.pageFields.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(displayPageField(name))}</option>`).join("");
  const picker = options ? `<p class="muted">Or select a detected page field:</p><select class="field-picker" data-page-field-picker><option value="">Select a field…</option>${options}</select>` : '<p class="muted">Detecting fields from this page…</p>';
  return `<div class="tool-title"><div><h3>Field Inspector</h3><p>Click a field label on the Salesforce page.</p></div><span class="pill">Listening</span></div><div class="notice">Click the label on the page, or use the detected-field list below. Metadata is optional; page-layout API names work without a REST session.</div>${picker}`;
}

function renderInspector() {
  if (!state.context?.recordId) return noRecordMessage("Field Inspector");
  state.inspectorOn = !state.inspectorOn;
  sendToTab({ type: "set-field-inspector", enabled: state.inspectorOn }).then((response) => {
    if (state.inspectorOn && !response?.enabled) toast("Refresh the Salesforce tab, then turn Field Inspector on again.");
  });
  document.querySelector('[data-action="inspect"]').classList.toggle("active", state.inspectorOn);
  if (state.inspectorOn) {
    showTool(inspectorContent());
  } else {
    showTool(`<div class="tool-title"><div><h3>Field Inspector paused</h3><p>Turn it back on when you want to inspect another field.</p></div></div>`);
  }
}

function renderPermissions() {
  if (!state.context?.recordId) return noRecordMessage("Permission Debugger");
  const selected = state.selectedField;
  const options = state.pageFields.map((name) => `<option value="${escapeHtml(name)}" ${selected?.name === name ? "selected" : ""}>${escapeHtml(displayPageField(name))}</option>`).join("");
  const picker = options ? `<p class="muted">Check a visible page field:</p><select class="field-picker" data-permission-field-picker><option value="">Select a field…</option>${options}</select>` : '<p class="muted">Visible field names are still loading from this page.</p>';
  const fieldSignal = selected
    ? `<div class="permission good"><b>✓</b><span><strong>Field visibility</strong><br>${escapeHtml(selected.name)} is exposed on this record page.</span></div>`
    : '<div class="permission unknown"><b>•</b><span><strong>Field visibility</strong><br>Select a visible field to check its page-access signal.</span></div>';
  showTool(`<div class="tool-title"><div><h3>Permission Debugger</h3><p>Signed-in user access signals from this Salesforce page.</p></div><span class="pill">Page access</span></div>
    <div class="permission good"><b>✓</b><span><strong>Record access</strong><br>This record is open for the signed-in user.</span></div>
    <div class="permission good"><b>✓</b><span><strong>Object access</strong><br>${escapeHtml(state.context.objectName)} is rendered in the current Salesforce session.</span></div>
    ${fieldSignal}
    <div class="permission unknown"><b>•</b><span><strong>Edit / assigned permission set</strong><br>Salesforce does not expose an authoritative FLS or permission-set evaluation from this page session.</span></div>
    <div class="notice"><strong>Accurate scope:</strong> this debugger reports what the signed-in user can see on the open record. It does not guess another user’s profile, permission sets, or field-level security.</div>
    ${picker}<div class="button-row"><button data-action="inspect">Inspect selected field</button></div>`);
}

function renderRelated() {
  if (!state.context?.recordId) return noRecordMessage("Related Records");
  const lookups = fieldCandidates().filter((field) => field.type === "reference").slice(0, 12);
  const values = state.record || {};
  showTool(`<div class="tool-title"><div><h3>Related Records</h3><p>Lookup relationships on this ${escapeHtml(state.context.objectName)}.</p></div></div>${lookups.length ? `<dl class="detail-list">${lookups.map((field) => `<div class="detail-row"><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(values[field.name] || field.referenceTo?.join(", ") || "Lookup")}</dd></div>`).join("")}</dl>` : '<div class="notice">No lookup fields are available yet. Load metadata to discover related objects.</div>'}<div class="button-row"><button class="primary-button" data-load-record>Load record values</button>${state.describe ? "" : '<button data-load-metadata>Load relationships</button>'}</div>`);
}

function renderAutomation() {
  if (!state.context?.recordId) return noRecordMessage("Debug Automation");
  const object = state.context.objectName;
  showTool(`<div class="tool-title"><div><h3>Automation Debugger</h3><p>A focused handoff for ${escapeHtml(object)}.</p></div></div><div class="detail-list"><div class="detail-row"><dt>Record</dt><dd>${escapeHtml(state.context.recordId)}</dd></div><div class="detail-row"><dt>Check 1</dt><dd>Record-triggered flows</dd></div><div class="detail-row"><dt>Check 2</dt><dd>Apex triggers and debug logs</dd></div><div class="detail-row"><dt>Check 3</dt><dd>Validation rules / approvals</dd></div></div><div class="notice">Salesforce does not expose a safe, universal “why automation ran” API from a record page. Use this record ID when filtering debug logs or Flow interviews.</div><div class="button-row"><button data-copy="${escapeHtml(state.context.recordId)}">Copy Record ID</button><button data-open-setup="flows">Open Flows</button><button data-open-setup="logs">Open Debug Logs</button></div>`);
}

function renderApi() {
  if (!state.context?.recordId) return noRecordMessage("Inspect API");
  const c = state.context;
  const endpoint = `${c.host}/services/data/v61.0/sobjects/${c.objectName}/${c.recordId}`;
  showTool(`<div class="tool-title"><div><h3>API Inspector</h3><p>Call the current record through the Salesforce REST API.</p></div><span class="pill">v61.0</span></div><pre>GET /services/data/v61.0/sobjects/${escapeHtml(c.objectName)}/${escapeHtml(c.recordId)}</pre><div class="button-row"><button class="primary-button" data-load-record>Fetch current record</button><button data-copy="${escapeHtml(endpoint)}">Copy endpoint</button></div>${state.record ? `<pre>${escapeHtml(JSON.stringify(state.record, null, 2))}</pre>` : ""}`);
}

function renderExport() {
  if (!state.context?.recordId) return noRecordMessage("Export Data");
  const data = state.pageRecord;
  const count = data ? Object.keys(data).length : 0;
  const body = state.pageRecordLoading
    ? '<div class="notice">Reading the fields currently visible on the Salesforce record page…</div>'
    : count
      ? `<div class="notice">${count} visible page fields are ready. This export is created locally in your browser.</div><div class="button-row"><button class="primary-button" data-export="json">Download JSON</button><button data-export="csv">Download CSV</button><button data-load-page-record>Refresh page data</button></div>`
      : `<div class="notice">${escapeHtml(state.pageRecordError || "No visible page fields have been collected yet.")}</div><button class="primary-button" data-load-page-record>Read visible page data</button>`;
  showTool(`<div class="tool-title"><div><h3>Export Record</h3><p>Download fields visible in the current Salesforce page as JSON or CSV.</p></div><span class="pill">Page data</span></div>${body}`);
  if (data === null && !state.pageRecordLoading && !state.pageRecordError) loadPageRecord();
}

async function loadPageFields() {
  const response = await chrome.runtime.sendMessage({ type: "sf-page-fields", tabId: state.tabId }).catch(() => null);
  if (!response?.ok) return;
  state.pageFields = [...new Set(response.fields || [])].filter(isUsablePageField);
  if (state.activeAction === "soql") renderSoql(); else if (state.activeAction === "inspect" && state.inspectorOn) showTool(inspectorContent());
}

async function sendToTab(message) {
  if (!state.tabId) return null;
  try { return await chrome.tabs.sendMessage(state.tabId, message); } catch { return null; }
}

async function apiRequest(action, payload) {
  const response = await chrome.runtime.sendMessage({ type: "sf-api-request", tabId: state.tabId, action, payload });
  if (!response?.ok) throw new Error(response?.error || "Salesforce did not respond.");
  return response.result;
}

async function requestDescribe() {
  if (!state.context?.objectName || state.describe || state.describeLoading) return;
  state.describeLoading = true;
  try {
    const describe = await apiRequest("describe", { objectName: state.context.objectName });
    state.describe = describe;
    state.metadataError = null;
    $("#api-status").textContent = "Metadata connected";
    $("#api-status").className = "status connected";
  } catch (error) {
    state.metadataError = error.message;
    $("#api-status").textContent = "Page context only";
    $("#api-status").className = "status warning";
  } finally { state.describeLoading = false; }
}

async function loadMetadata() {
  toast("Loading Salesforce metadata…");
  state.describe = null;
  await requestDescribe();
  if (state.describe) { toast("Object metadata loaded"); dispatchAction(state.activeAction || "inspect"); }
  else toast(state.metadataError || "Metadata is unavailable for this session.");
}

async function loadPageRecord() {
  if (state.pageRecordLoading || !state.context?.recordId) return;
  state.pageRecordLoading = true;
  state.pageRecordError = null;
  if (state.activeAction === "export") renderExport();
  try {
    const response = await sendToTab({ type: "get-visible-page-record" });
    if (!response?.ok) throw new Error("Refresh the Salesforce record tab, then try again.");
    state.pageRecord = response.record || {};
    toast(`${Object.keys(state.pageRecord).length} visible fields prepared for export`);
  } catch (error) {
    state.pageRecord = null;
    state.pageRecordError = error.message || "Could not read the visible record fields.";
    toast(state.pageRecordError);
  } finally {
    state.pageRecordLoading = false;
    if (state.activeAction === "export") renderExport();
  }
}

async function loadRecord() {

  if (!state.context?.recordId) return;
  toast("Fetching current record…");
  try {
    state.record = await apiRequest("record", state.context);
    toast("Record data loaded");
    dispatchAction(state.activeAction || "api");
  } catch (error) { toast(error.message); }
}

function downloadExport(kind) {
  if (!state.pageRecord || !Object.keys(state.pageRecord).length) return toast("Read visible page data before exporting.");
  const data = { ...state.pageRecord };

  delete data.attributes;
  let contents; let type; let extension;
  if (kind === "csv") {
    const columns = Object.keys(data);
    const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    contents = `${columns.join(",")}\n${columns.map((key) => cell(data[key])).join(",")}`;
    type = "text/csv"; extension = "csv";
  } else { contents = JSON.stringify(data, null, 2); type = "application/json"; extension = "json"; }
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = `${state.context.objectName}-${state.context.recordId}.${extension}`; a.click();
  URL.revokeObjectURL(url); toast(`Downloaded ${extension.toUpperCase()} export`);
}

function openSetup(kind) {
  const path = kind === "flows" ? "/lightning/setup/Flows/home" : "/lightning/setup/DebugLogs/home";
  chrome.tabs.create({ url: `https://${state.context.host}${path}` });
}

function openField(apiName) {
  const { host, objectName } = state.context;
  chrome.tabs.create({ url: `https://${host}/lightning/setup/ObjectManager/${objectName}/FieldsAndRelationships/${apiName}/view` });
}

function dispatchAction(action) {
  state.activeAction = action;
  document.querySelectorAll(".action-card").forEach((button) => button.classList.toggle("active", button.dataset.action === action && action !== "inspect"));
  ({ inspect: renderInspector, "copy-id": () => state.context?.recordId ? copy(state.context.recordId, "Record ID copied") : toast("No record ID detected"), permissions: renderPermissions, soql: renderSoql, related: renderRelated, automation: renderAutomation, api: renderApi, export: renderExport }[action])?.();
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action) return dispatchAction(action);
  const copyValue = event.target.closest("[data-copy]")?.dataset.copy;
  if (copyValue) return copy(copyValue);
  const fieldName = event.target.closest("[data-copy-soql]")?.dataset.copySoql;
  if (fieldName) return copy(baseQuery(["Id", fieldName]), "Field SOQL copied");
  const openFieldName = event.target.closest("[data-open-field]")?.dataset.openField;
  if (openFieldName) return openField(openFieldName);
  if (event.target.closest("[data-copy-query]")) return copy(baseQuery(defaultQueryFields()), "Query copied");
  if (event.target.closest("[data-load-metadata]")) return loadMetadata();
  if (event.target.closest("[data-load-record]")) return loadRecord();
  if (event.target.closest("[data-load-page-record]")) return loadPageRecord();

  const exportKind = event.target.closest("[data-export]")?.dataset.export;
  if (exportKind) return downloadExport(exportKind);
  const setup = event.target.closest("[data-open-setup]")?.dataset.openSetup;
  if (setup) return openSetup(setup);
});

document.addEventListener("change", (event) => {
  const permissionField = event.target.closest("[data-permission-field-picker]")?.value;
  if (permissionField) {
    state.selectedField = { name: permissionField, label: displayPageField(permissionField), type: "Unknown (page layout)", nillable: true };
    state.activeAction = "permissions";
    return renderPermissions();
  }
  const apiName = event.target.closest("[data-page-field-picker]")?.value;

  if (!apiName) return;
  state.selectedField = { name: apiName, label: displayPageField(apiName), type: "Unknown (page layout)", nillable: true };
  renderField(state.selectedField, displayPageField(apiName));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab?.id !== state.tabId || message?.type !== "sf-event") return;
  if (message.event === "context") {
    state.describe = null; state.record = null; state.selectedField = null;
    updateContext(message.context);
  }
  if (message.event === "field-selected" && state.inspectorOn) {
    state.selectedField = fieldForSelection(message.payload);
    renderField(state.selectedField, message.payload.label);
  }
  if (message.event === "api-result") {
    const pending = state.pending.get(message.payload.requestId);
    if (pending) {
      clearTimeout(pending.timer); state.pending.delete(message.payload.requestId);
      message.payload.error ? pending.reject(new Error(message.payload.error)) : pending.resolve(message.payload.result);
    }
  }
  sendResponse?.();
});

async function initialize() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [fallbackTab] = currentTab ? [currentTab] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = currentTab || fallbackTab;
  state.tabId = tab?.id || null;
  if (!state.tabId) return;
  const [savedContext, detected] = await Promise.all([
    chrome.runtime.sendMessage({ type: "get-sf-context", tabId: state.tabId }).catch(() => null),
    chrome.runtime.sendMessage({ type: "detect-sf-context", tabId: state.tabId }).catch((error) => ({ ok: false, error: error.message }))
  ]);
  const saved = savedContext?.recordId && savedContext?.objectName ? savedContext : null;
  const context = detected?.context || saved || null;
  if (context) {
    updateContext(context);
  } else {
    $("#subtitle").textContent = detected?.error || "Could not read the active Salesforce record.";
  }
}

initialize();
