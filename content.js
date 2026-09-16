const STANDARD_PREFIXES = {
  "001": "Account", "003": "Contact", "005": "User", "006": "Opportunity",
  "00Q": "Lead", "00T": "Task", "00U": "Event", "500": "Case",
  "701": "Campaign", "800": "Contract", "a0": "Custom object"
};

let inspectorEnabled = false;
let lastUrl = "";
let bridgeReady = false;

function objectFromRecordId(recordId) {
  if (!recordId) return null;
  const prefix = recordId.slice(0, 3);
  return STANDARD_PREFIXES[prefix] || (prefix.startsWith("a0") ? "Custom object" : null);
}

function parseContext(url = location.href) {
  const lightningRecord = url.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//);
  const classicRecord = url.match(/\/([a-zA-Z0-9]{15,18})(?:[/?#]|$)/);
  const objectList = url.match(/\/lightning\/o\/([^/]+)\//);
  const recordId = lightningRecord?.[2] || classicRecord?.[1] || null;
  const objectName = lightningRecord?.[1] || objectList?.[1] || objectFromRecordId(recordId);

  return {
    url,
    host: location.host,
    isSalesforce: true,
    objectName: objectName ? decodeURIComponent(objectName) : null,
    recordId,
    pageType: recordId ? "record" : objectName ? "object" : "other"
  };
}

function sendContext() {
  const context = parseContext();
  chrome.runtime.sendMessage({ type: "sf-context", context }).catch(() => {});
  chrome.runtime.sendMessage({ type: "sf-event", event: "context", context }).catch(() => {});
}

function injectBridge() {
  if (document.documentElement.dataset.sfHelperBridge) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.async = false;
  script.onload = () => script.remove();
  document.documentElement.dataset.sfHelperBridge = "true";
  (document.head || document.documentElement).append(script);
}

function valueFromNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";
  return [
    node.getAttribute("data-field-name"), node.getAttribute("field-name"),
    node.getAttribute("name"), node.getAttribute("aria-label"), node.getAttribute("title"),
    node.textContent
  ].find((value) => value && value.trim())?.trim().replace(/\s+/g, " ").slice(0, 160) || "";
}

function labelFromNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";
  const direct = ["data-field-label", "field-label", "label", "data-label"]
    .map((name) => node.getAttribute?.(name))
    .find((value) => value?.trim());
  if (direct) return direct.trim().replace(/\s+/g, " ").slice(0, 120);
  const container = node.closest?.("records-record-layout-item, force-record-layout-item, lightning-output-field, [data-field-name], [field-name], .slds-form-element");
  const containedLabel = container?.querySelector?.("label, .slds-form-element__label, [data-field-label]")?.textContent?.trim();
  if (containedLabel) return containedLabel.replace(/\s+/g, " ").slice(0, 120);
  const text = node.textContent?.trim().replace(/\s+/g, " ") || "";
  return text.length <= 120 ? text : "";
}

function inspectionFromEvent(event) {
  const path = event.composedPath?.() || [event.target];
  const elements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const explicitApiName = elements
    .map((node) => node.getAttribute?.("data-field-name") || node.getAttribute?.("field-name"))
    .find(Boolean) || null;
  const label = elements.map(labelFromNode).find(Boolean) || "";
  if (!label || label.length > 120) return null;

  return {
    label,
    apiName: explicitApiName,
    objectName: parseContext().objectName,
    source: "page-click"
  };
}

function collectVisiblePageRecord() {
  const record = {};
  const customField = /^(?:[A-Za-z][A-Za-z0-9_]*__)+c$/;
  const standardFields = new Set(["Name", "OwnerId", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "RecordTypeId", "CurrencyIsoCode"]);
  const fieldFromValue = (value) => {
    if (typeof value !== "string") return null;
    const parts = value.split("RecordField.").pop().split(/[./:#\s[\]()]+/).filter(Boolean);
    return parts.reverse().find((part) => customField.test(part) || standardFields.has(part)) || null;
  };
  const textFrom = (node) => node?.textContent?.replace(/\s+/g, " ").trim() || "";
  const visited = new Set();
  const visit = (root) => {
    if (!root || visited.has(root)) return;
    visited.add(root);
    for (const element of root.querySelectorAll?.("*") || []) {
      let apiName = null;
      for (const attribute of element.attributes || []) {
        const attrName = attribute.name.toLowerCase();
        if (attrName.includes("field") || attrName.includes("selection-name")) apiName ||= fieldFromValue(attribute.value);
      }
      try { apiName ||= fieldFromValue(element.fieldName) || fieldFromValue(element.fieldApiName); } catch {}
      const label = ["field-label", "data-field-label", "label", "data-label"]
        .map((name) => element.getAttribute?.(name))
        .find((value) => value?.trim()) || "";
      const formatted = [...(element.shadowRoot?.querySelectorAll?.("lightning-formatted-text, lightning-formatted-number, lightning-formatted-date-time, a") || element.querySelectorAll?.("lightning-formatted-text, lightning-formatted-number, lightning-formatted-date-time, a") || [])]
        .map(textFrom).find((value) => value && value !== label);
      const value = (formatted || textFrom(element)).replace(label, "").replace(/\bEdit\b/g, "").trim();
      if (apiName && value && value.length <= 250 && !record[apiName]) record[apiName] = value;
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return record;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "sf-context-helper-bridge") return;
  chrome.runtime.sendMessage({ type: "sf-event", event: "api-result", payload: event.data.payload }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "set-field-inspector") {
    inspectorEnabled = Boolean(message.enabled);
    sendResponse({ enabled: inspectorEnabled });
    return;
  }
  if (message?.type === "get-visible-page-record") {
    sendResponse({ ok: true, record: collectVisiblePageRecord() });
    return;
  }
  if (message?.type === "sf-api-request") {
    injectBridge();
    window.postMessage({
      source: "sf-context-helper",
      requestId: message.requestId,
      action: message.action,
      payload: message.payload
    }, "*");
  }
});

document.addEventListener("click", (event) => {
  if (!inspectorEnabled) return;
  const field = inspectionFromEvent(event);
  if (field) chrome.runtime.sendMessage({ type: "sf-event", event: "field-selected", payload: field }).catch(() => {});
}, true);

injectBridge();
sendContext();
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    sendContext();
  }
}, 750);
