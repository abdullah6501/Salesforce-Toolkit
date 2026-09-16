# Salesforce Context Helper

A lightweight Chrome side-panel extension for Salesforce admins and developers. It reads the current Lightning record URL, exposes the record ID and object, then helps with field inspection, SOQL, current-user permission checks, related records, API inspection, and local record export.

## Install locally

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this folder.
4. Open a Salesforce Lightning record, click the extension icon, and select a quick action.

## What is live versus page-assisted

- **Always available:** Salesforce URL context, copying record IDs, starter SOQL, automation handoff, and field-label inspection using standard-field fallbacks.
- **When the Salesforce REST session is available:** object describe metadata, real field labels/types, current-user object permissions, record values, related lookup values, API data, and local JSON/CSV export.
- **Cross-user permission diagnosis:** deliberately not guessed. A Salesforce browser session normally represents the signed-in user only, so the Permission Debugger calls this out and directs the admin to validate a different user through Salesforce Setup or by signing in as them.

The extension does not send record data to a third-party server. Its optional API calls run against the Salesforce org currently open in the tab.
