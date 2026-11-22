# OutboundXray privacy policy

OutboundXray exists to show you what websites send about you, so it is built to send nothing about you itself.

## What OutboundXray collects

Nothing leaves your computer. OutboundXray has no server, no analytics, no crash reporting and makes no network requests of its own.

## What OutboundXray reads, and why

Only while you are scanning a tab (you start and stop it yourself):

- **The requests that tab sends**: addresses, headers, cookie names and request bodies, so it can show you what was sent and to whom.
- **Text you type into that tab's fields**, so it can tell you if that text (or a hashed copy of it) is sent somewhere. Password fields, one-time-code fields and payment-card fields are never read.

## Where it is kept

In the extension's memory only. Typed text is discarded as soon as you stop scanning or close the tab. Captured requests are kept for the open tab until you clear them, start a new scan, or close the tab. Nothing is written to disk, except a list of which tab IDs are being scanned (kept in Chrome's in-memory session storage, so a restarted extension can carry on).

**Export JSON** writes the captured requests to a file only when you click it.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Read full outgoing requests, including bodies, WebSocket messages and requests from embedded frames, for the tab you scan |
| `<all_urls>` host access | Run the typed-text watcher on the pages you scan, and read tab addresses |
| `sidePanel` | Show the results next to the page |
| `storage` | Remember which tabs are being scanned if Chrome restarts the extension |

## Contact

Questions or concerns: open an issue on the project's GitHub repository.
