# verification

## checked workflows

verification used disposable linux arm64 browser profiles with chromium for
testing 156.0.8078.4. it did not change a daily-use browser profile or coding
configuration.

- preview generation leaves browser tabs unchanged until `Apply groups`.
- renaming, inclusion, merge and move edit the local proposal without inference.
- apply preserves pinned tabs and existing group members.
- undo restores the applied tabs' order and membership, and refuses stale layouts.
- regroup submits only previously unchecked eligible tab ids in the current window.
- regroup can extend a pending proposal or an existing browser group, including a single-tab addition.
- failed and cancelled regroup requests leave saved preferences and the checked-tab checkpoint unchanged.
- a browser restart clears the checkpoint; saved provider and grouping preferences remain.
- stale previews, missing assignments, duplicate ids and invalid destinations are rejected.
- recovery and undo survive an extension-worker restart in the exercised cases.

these checks establish the exercised behavior, not perfect grouping quality.
model output still needs review. no fixed coverage or group-count guarantee is
made.

## provider coverage

real codex account discovery, preview generation, cancellation, apply and undo
were exercised through browser native messaging. permission-profile,
instruction-source and execution-environment checks were inspected against the
codex 0.166.0 protocol. account model availability is not a compatibility promise
for another account or codex version.

a synthetic prompt-injection case did not read its file canary, write a file or
reach its network canary. this is one exercised input, not proof against every
prompt injection. the connector also rejects tool requests and unexpected tool
activity.

openai-compatible transport used local http chat-completions fixtures. both
classification stages and strict result validation were exercised. this is not
certification of every remote provider. one isolated fixture pregranted loopback
access in a task-local manifest; that permission was not added to the shipped
manifest. native and api results pass the same plan validator.

## interface and identity

dark and light modes were inspected at 320, 360 and 480 pixels. checks covered
horizontal overflow, 44-pixel action targets, keyboard radio selection, settings
and privacy disclosures, first-run setup, and the editor's escape/focus behavior.
chromium's platform-font inspection confirmed that the heading used bundled
geist rather than a fallback font.

the sidebar redesign was exercised against an isolated loopback api fixture:
settings save, direct connector download visibility, keyboard settings disclosure,
rename, move, merge, apply, exact undo, incremental checks, cancellation and an
http 401 response. an existing-group addition preserved its four original members
through apply and undo. setup hides inactive grouping controls until a model is
selected, while retaining the privacy disclosure. the sticky apply area remained
visible at 320 by 700 pixels. no production permissions were added.

the reduced-copy sidebar keeps the selected model and group counts inline.
hostname subtitles and persistent helper captions were removed from the visible
preview; sanitized urls remain in hover titles and hostnames remain available to
screen readers. a fresh fixture check covered rename, merge, move-dialog escape
and focus restoration, apply, exact undo, and the pre-apply confirmation at
320, 360 and 480 pixels in both themes.

the selected tabset logo was checked in both themes at 320 and 360 pixels.
chrome's registered 48-pixel icon matched the packaged png. the original
extension key and id are preserved. the panel uses the approved svg as a
current-color mask; native code does not depend on the logo.

## source checks

```sh
bun run typecheck
bun run lint
bun run test:core
bun run build
```

the focused core suite has 28 tests and 44 assertions. it covers preference
validation, assignment completeness, anchor matching, single existing-group
additions, destination identity, duplicate targets and metadata restrictions.
lint exits successfully with nine complexity warnings; this is not a
warning-free result.

release packaging checks zip integrity, packaged files, font and software
licenses, extension identity, and relative document links. secret scans report
the manifest's intentionally public extension identity key; it was validated as
a public key and is not a signing private key.

## unverified areas

- macos, windows, edge and older chromium versions have not been exercised.
- the installer's interactive `--login` wrapper has not been exercised end to end; account verification used the same dedicated codex home.
- remote api compatibility, provider limits and model quality depend on the endpoint and account.
- browser tab mutations are not transactional. concurrent changes can interrupt apply or undo; inspect the reported recovery status.
- closing the panel discards unapplied local edits. browser restart requires a new successful check before regroup.
- the logo's resemblance review used selected sections of kuwayama's source books because the archive site was unavailable. it is not legal trademark clearance.
