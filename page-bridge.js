(() => {
  const SOURCE = "sf-context-helper";
  const RESPONSE_SOURCE = "sf-context-helper-bridge";

  function respond(requestId, result, error) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      payload: { requestId, result, error: error || null }
    }, "*");
  }

  async function salesforceFetch(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.[0]?.message || body?.message || `Salesforce returned ${response.status}`);
    return body;
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const { requestId, action, payload = {} } = event.data;
    try {
      let result;
      if (action === "describe") {
        result = await salesforceFetch(`/services/data/v61.0/sobjects/${encodeURIComponent(payload.objectName)}/describe`);
      } else if (action === "record") {
        result = await salesforceFetch(`/services/data/v61.0/sobjects/${encodeURIComponent(payload.objectName)}/${encodeURIComponent(payload.recordId)}`);
      } else if (action === "query") {
        result = await salesforceFetch(`/services/data/v61.0/query?q=${encodeURIComponent(payload.soql)}`);
      } else {
        throw new Error("Unsupported Salesforce request.");
      }
      respond(requestId, result);
    } catch (error) {
      respond(requestId, null, error.message || "Could not call the Salesforce API from this page.");
    }
  });
})();
