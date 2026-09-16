async function collectPageFields(tabId) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const fields = new Set();
      const standardFields = new Set(["Name", "OwnerId", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "RecordTypeId", "CurrencyIsoCode"]);

      const add = (value) => {
        if (typeof value !== "string") return;
        const raw = value.trim();
        const segments = raw.split("RecordField.").pop().split(/[./:#\s[\]()]+/).filter(Boolean);
        const candidate = segments.reverse().find((part) => /^(?:[A-Za-z][A-Za-z0-9_]*__)+c$/.test(part) || standardFields.has(part)) || raw;
        if (candidate !== "Id" && (/^(?:[A-Za-z][A-Za-z0-9_]*__)+c$/.test(candidate) || standardFields.has(candidate))) fields.add(candidate);
      };
      const visited = new Set();
      const visit = (root) => {
        if (!root || visited.has(root)) return;
        visited.add(root);
        for (const element of root.querySelectorAll?.("*") || []) {
          for (const attribute of element.attributes || []) {
            const name = attribute.name.toLowerCase();
            if (name.includes("field") || name.includes("selection-name")) add(attribute.value);
          }
          try { add(element.fieldName); add(element.fieldApiName); } catch {}
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
      return [...fields].slice(0, 40);
    }
  });
  return { ok: true, fields: execution?.result || [] };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "sf-page-fields") return;
  collectPageFields(message.tabId)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "Could not inspect page fields." }));
  return true;
});
function apiPathFor(action, payload = {}) {
  if (action === "describe") {
    return `/services/data/v61.0/sobjects/${encodeURIComponent(payload.objectName)}/describe`;
  }
  if (action === "record") {
    return `/services/data/v61.0/sobjects/${encodeURIComponent(payload.objectName)}/${encodeURIComponent(payload.recordId)}`;
  }
  if (action === "layout") {
    return `/services/data/v61.0/ui-api/record-ui/${encodeURIComponent(payload.recordId)}?layoutTypes=Full&modes=View`;
  }
  if (action === "query") {
    return `/services/data/v61.0/query?q=${encodeURIComponent(payload.soql)}`;
  }
  throw new Error("Unsupported Salesforce request.");
}
async function runSalesforceRequest(tabId, action, payload) {
  const path = apiPathFor(action, payload);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [path],
    func: async (requestPath) => {
      const endpoints = [requestPath];
      if (location.hostname.endsWith(".lightning.force.com")) {
        endpoints.push(`https://${location.hostname.replace(".lightning.force.com", ".my.salesforce.com")}${requestPath}`);
      }
      let lastError = "The Salesforce API request failed.";
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            credentials: endpoint === requestPath ? "same-origin" : "include",
            headers: { Accept: "application/json" }
          });
          const result = await response.json().catch(() => null);
          if (response.ok) return { ok: true, result, endpoint: response.url };
          lastError = result?.[0]?.message || result?.message || `${response.status} ${response.statusText} from ${new URL(endpoint, location.href).host}`;
        } catch (error) {
          lastError = error?.message || lastError;
        }
      }
      return { ok: false, error: lastError };
    }
  });
  const directResult = execution?.result || { ok: false, error: "Salesforce did not return a result." };
  if (directResult.ok) return directResult;
  return directResult;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "sf-api-request") return;
  runSalesforceRequest(message.tabId, message.action, message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "Could not reach the Salesforce page." }));
  return true;
});
const salesforceUrl = /https:\/\/[^/]+\.(salesforce\.com|force\.com|lightning\.force\.com)\//i;

async function configurePanel(tabId, url) {
  await chrome.sidePanel.setOptions({
    tabId,
    path: "panel.html",
    enabled: Boolean(url && salesforceUrl.test(url))
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => configurePanel(tab.id, tab.url).catch(() => {})));
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") {
    configurePanel(tabId, info.url || tab.url).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`sf-context-${tabId}`).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "sf-context" && sender.tab?.id) {
    chrome.storage.session.set({ [`sf-context-${sender.tab.id}`]: message.context });
  }

  if (message?.type === "get-sf-context") {
    chrome.storage.session.get(`sf-context-${message.tabId}`).then((result) => {
      sendResponse(result[`sf-context-${message.tabId}`] || null);
    });
    return true;
  }
});
function parseRecordContext(url, hints = {}) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})(?:\/|$)/)
      || parsed.hash.match(/\/sObject\/([^/]+)\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    const objectName = hints.objectName || (match ? decodeURIComponent(match[1]) : null);
    const recordId = hints.recordId || (match ? match[2] : null);
    return objectName && recordId ? { url, host: parsed.host, isSalesforce: true, objectName, recordId, pageType: "record" } : null;
  } catch {
    return null;
  }
}
async function detectPageContext(tabId) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const recordHost = document.querySelector("[record-id], [recordid]");
      return {
        url: location.href,
        recordId: recordHost?.getAttribute("record-id") || recordHost?.getAttribute("recordid") || recordHost?.recordId || null,
        objectName: recordHost?.getAttribute("object-api-name") || recordHost?.getAttribute("objectapiname") || recordHost?.objectApiName || null
      };
    }
  });
  const page = execution?.result;
  const context = parseRecordContext(page?.url, page);
  return context ? { ok: true, context } : { ok: false, error: `No Salesforce record route found: ${page?.url || "unknown page"}` };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "detect-sf-context") return;
  detectPageContext(message.tabId)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "Could not inspect the active Salesforce tab." }));
  return true;
});
