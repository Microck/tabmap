# Privacy

Tabmap sends browsing metadata to the model provider you select when you request a preview. It does not run automatic classification in the background.

## What leaves your browser

Generate preview submits eligible tabs in your current window. Regroup submits only previously unchecked eligible tabs. Both include their titles and sanitized URLs, your selected group detail, and optional instructions. URL usernames, passwords, query strings and fragments are removed. Titles and paths can still contain private information.

Requests also include the names, identifiers and member counts of named groups that may receive additions. They do not include those groups' old members' titles or URLs. Review your tab and group names before requesting a preview. Do not put secrets in Instructions.

Two or more submitted tabs use discovery and assignment through the same selected provider and model. A single tab needs only assignment when a destination exists. No new tabs means no model request. The extension does not read page contents, cookies, browser history, passwords or incognito tabs. Pinned tabs and internal pages are excluded from classification.

With Codex, inference runs through your Codex account, not on your computer. The native connector keeps OAuth credentials under Codex's control. With an API endpoint, requests go directly to the endpoint you configure. Your provider's data-retention and usage policies apply. Tabmap does not operate a relay or collection server.

## What stays on your device

Provider settings, grouping preferences, instructions, and any API key are saved in the extension's local storage. They are not synced through your browser account. The extension does not encrypt stored API keys or instructions. Use a key with an appropriate spending limit, and clear it in Settings when you no longer need it.

The model's preview, per-window checked-tab identifiers, and undo information remain in browser-session storage. This includes tab URLs used to detect changes before applying a plan. It is not sent to a developer service. Unapplied name, inclusion, Merge, and Move edits stay in the open panel; closing or reloading it discards those edits. Local preview edits do not send requests to either provider. Browser restart clears the checked-tab checkpoint; saved grouping preferences remain on the device.

The connector exposes model discovery and tab grouping, not arbitrary command execution. It launches its own Codex process with a dedicated Codex home and separate login; it does not attach to your other Codex sessions or copy their credentials or configuration. Keep this dedicated home free of custom instructions and integrations. Grouping stops if Codex reports loaded instruction files.

## Permissions

- **Tabs:** read eligible titles and URLs and restore tab order.
- **Tab groups:** read group names and membership counts, add proposed tabs or create named groups, and undo only the applied additions.
- **Side panel:** show settings and the grouping preview.
- **Storage:** retain settings and session-local preview and undo information.
- **Native messaging:** connect to your installed Codex connector, only for the Codex provider.
- **Optional endpoint access:** send requests to the API origin you approve. The extension requests this permission when you save that endpoint.

No content scripts, remote scripts, analytics or advertising are included.
