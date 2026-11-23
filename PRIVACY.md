# OutboundXray privacy policy

OutboundXray exists to show you what websites send about you, so it is built to send nothing about you itself.

## What OutboundXray collects

Nothing leaves your computer. OutboundXray has no server, no analytics, no crash reporting and makes no network requests of its own.

## What OutboundXray reads, and why

Only while you are scanning a tab (you start and stop it yourself):

- **The requests that tab sends**: addresses, headers, cookie names and request bodies, so it can show you what was sent and to whom.
- **Text you type into that tab's fields**, so it can tell you if that text (or a hashed copy of it) is sent somewhere. Password fields, one-time-code fields and payment-card fields are never read.

**Background watch** is on by default, and you can turn it off at the bottom of the side panel. While it is on, for every tab:

- **Requests sent to other companies**: their addresses and request bodies, so the toolbar icon can show the page's grade. Requests to the site itself are not kept. Cookies, headers, responses and live-connection messages are not read.
- **Text you type into fields**, with the same exceptions as above, so it can warn you (with a notification) if that text, an email address or a phone number is sent to another company.

## Where it is kept

In the extension's memory only. Typed text is discarded as soon as you stop scanning or close the tab, and for background watch, when you close the tab or turn background watch off. Captured requests are kept for the open tab until you clear them, start a new scan, or close the tab. Background watch keeps at most the last 300 requests to other companies per tab, and forgets a tab's requests when it loads a new page. Nothing is written to disk, except two things. First, a list of which tab IDs are being scanned. Second, while background watch is on, each tab's background-watch data. Both are kept in Chrome's session storage, which lives in memory and is cleared when Chrome quits, so a restarted extension can carry on. Whether background watch is on is remembered as a single on/off setting.

**Export JSON** writes the captured requests to a file only when you click it.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Read full outgoing requests, including bodies, WebSocket messages and requests from embedded frames, for the tab you scan |
| `<all_urls>` host access | Run the typed-text watcher on the pages you scan, and on every page while background watch is on, and read tab addresses |
| `sidePanel` | Show the results next to the page |
| `storage` | Remember which tabs are being scanned if Chrome restarts the extension, and whether background watch is on |
| `webRequest` | Background watch only: see the addresses and bodies of requests pages send to other companies, without the debugging bar |
| `notifications` | Background watch only: tell you when personal information leaves a page |

## Contact

Questions or concerns: open an issue on the project's GitHub repository.
