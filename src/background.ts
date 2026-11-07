import { DEFAULT_SETTINGS, DEFAULT_GROUPING, MAX_TABS, parseGrouping, parsePlan, parseTargets, sanitizeUrl, type AppState, type GroupingPreferences, type GroupTarget, type Plan, type Reply, type Request, type Settings, type TabInput } from "./shared";
import { groupTabs, listModels } from "./providers";

interface SnapshotTab { id: number; url: string; title: string; pinned: boolean; groupId: number; index: number }
interface Snapshot { windowId: number; tabs: SnapshotTab[] }
interface Undo { before: Snapshot; after: Snapshot; addedTabIds: number[] }
let state: AppState = { settings: DEFAULT_SETTINGS, grouping: DEFAULT_GROUPING, models: [], preview: null, busy: false, status: "", error: null, canUndo: false, checkedTabs: {} };
let previewSnapshot: Snapshot | null = null;
let undo: Undo | null = null;
let controller: AbortController | null = null;
const ready = initialize();

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const saved = await chrome.storage.local.get(["settings", "grouping"]);
  if (saved.settings) state.settings = validateSettings(saved.settings);
  if (saved.grouping) state.grouping = parseGrouping(saved.grouping);
  const session = await chrome.storage.session.get<{ state?: AppState; previewSnapshot?: Snapshot; undo?: Undo }>(["state", "previewSnapshot", "undo"]);
  if (session.state) {
    if (!session.state.checkedTabs || (session.undo && !Array.isArray(session.undo.addedTabIds))) {
      throw new Error("The session format is invalid. Restart the browser to begin a new session.");
    }
    state = { ...session.state, settings: state.settings, grouping: state.grouping, busy: false };
    if (session.state.busy) {
      state.error = "The previous operation was interrupted. Check your tabs and recovery state before trying again.";
      state.status = "Operation interrupted";
    }
  }
  previewSnapshot = session.previewSnapshot ?? null;
  undo = session.undo ?? null;
  state.canUndo = undo !== null;
  state.checkedTabs = await prunedCheckedTabs();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || !("provider" in value) || !("model" in value)
      || typeof value.model !== "string" || value.model.length > 200) throw new Error("Choose a provider and a valid model ID.");
  if (value.provider === "codex") return { provider: "codex", model: value.model.trim() };
  if (value.provider !== "api" || !("endpoint" in value) || !("apiKey" in value)
      || typeof value.endpoint !== "string" || typeof value.apiKey !== "string") throw new Error("Enter an API endpoint and API key.");
  const endpoint = new URL(value.endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) throw new Error("Use HTTPS for the endpoint, or HTTP on localhost.");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("The endpoint must not contain credentials, a query, or a fragment.");
  return { provider: "api", endpoint: endpoint.href.replace(/\/$/, ""), apiKey: value.apiKey.trim(), model: value.model.trim() };
}

async function publish() {
  await chrome.storage.session.set({ state, previewSnapshot, undo });
  // A closed panel has no listener. State is retained for its next opening.
  await chrome.runtime.sendMessage({ type: "state", state }).catch(() => undefined);
}

async function prunedCheckedTabs(): Promise<AppState["checkedTabs"]> {
  const tabs = await chrome.tabs.query({});
  const windows = new Set(tabs.map(tab => String(tab.windowId)));
  const open = new Map(tabs.map(tab => [tab.id, String(tab.windowId)]));
  return Object.fromEntries(Object.entries(state.checkedTabs)
    .filter(([windowId]) => windows.has(windowId))
    .map(([windowId, ids]) => [windowId, ids.filter(id => open.get(id) === windowId)]));
}

async function snapshot(windowId: number): Promise<Snapshot> {
  const window = await chrome.windows.get(windowId);
  if (window.incognito || window.type !== "normal") throw new Error("Open a normal, non-incognito browser window.");
  const tabs = await chrome.tabs.query({ windowId });
  return { windowId, tabs: tabs.sort((a, b) => a.index - b.index).map(tab => {
    if (tab.id === undefined || !tab.url) throw new Error("A tab is still loading. Wait a moment and try again.");
    return { id: tab.id, url: tab.url, title: tab.title ?? "", pinned: tab.pinned, groupId: tab.groupId, index: tab.index };
  }) };
}

async function browserTargets(before: Snapshot): Promise<GroupTarget[]> {
  const counts = new Map<number, number>();
  for (const tab of before.tabs) counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
  const groups = await chrome.tabGroups.query({ windowId: before.windowId });
  return groups.filter(group => group.title?.trim()).map(group => ({
    id: `browser:${group.id}`, name: group.title!, tabCount: counts.get(group.id) ?? 0,
  }));
}

function eligible(tabs: SnapshotTab[]): TabInput[] {
  return tabs.flatMap(tab => {
    const url = sanitizeUrl(tab.url);
    return url && !tab.pinned && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
      ? [{ id: tab.id, title: tab.title, url }] : [];
  });
}

function unchanged(before: Snapshot, after: Snapshot, checkTitles = true): boolean {
  return before.windowId === after.windowId && before.tabs.length === after.tabs.length && before.tabs.every((tab, index) => {
    const current = after.tabs[index];
    return current && tab.id === current.id && tab.url === current.url && tab.pinned === current.pinned
      && tab.groupId === current.groupId && (!checkTitles || tab.title === current.title);
  });
}

function sameTargets(before: GroupTarget[], after: GroupTarget[], allowAdded = false): boolean {
  const current = new Map(after.map(target => [target.id, target]));
  return (allowAdded || before.length === after.length) && before.every(target => {
    const match = current.get(target.id);
    return match !== undefined && match.name === target.name && match.tabCount === target.tabCount;
  });
}

function validatePreviewGrowth(before: Snapshot, current: Snapshot, targets: GroupTarget[]) {
  const oldIds = new Set(before.tabs.map(tab => tab.id));
  const oldGroups = new Set(before.tabs.map(tab => `browser:${tab.groupId}`));
  const oldTargets = new Set(state.preview?.targets.map(target => target.id));
  if (!unchanged(before, { windowId: current.windowId, tabs: current.tabs.filter(tab => oldIds.has(tab.id)) })
      || !state.preview || !sameTargets(state.preview.targets, targets, true)
      || targets.some(target => !oldTargets.has(target.id) && oldGroups.has(target.id))) {
    throw new Error("The previous preview changed beyond added tabs. Generate a new full preview.");
  }
}

function mergePlan(prior: Plan, additions: Plan): Plan {
  const combined: Plan = {
    groups: prior.groups.map(group => ({ ...group, tabIds: [...group.tabIds] })),
    ungrouped: [...prior.ungrouped, ...additions.ungrouped],
  };
  for (const group of additions.groups) {
    if (group.targetId?.startsWith("draft:")) {
      const destination = combined.groups[Number(group.targetId.slice(6))];
      if (!destination || destination.targetId !== null) throw new Error("The pending group destination is no longer available.");
      destination.tabIds.push(...group.tabIds);
    } else {
      const destination = group.targetId === null ? undefined : combined.groups.find(priorGroup => priorGroup.targetId === group.targetId);
      if (destination) destination.tabIds.push(...group.tabIds);
      else combined.groups.push({ ...group, tabIds: [...group.tabIds] });
    }
  }
  return combined;
}

// Generate and Regroup share classification and validation. Only the submitted tabs
// reach the provider; earlier preview assignments are merged locally after success.
async function generate(windowId: number, signal: AbortSignal, incremental?: { draft: Plan | null; grouping: GroupingPreferences }) {
  const grouping = incremental ? parseGrouping(incremental.grouping) : state.grouping;
  const checked = state.checkedTabs[String(windowId)];
  if (incremental && checked === undefined) throw new Error("Generate a successful preview in this window before using Regroup.");
  if (!incremental) {
    state.preview = null;
    previewSnapshot = null;
  }
  const before = await snapshot(windowId);
  const targets = parseTargets(await browserTargets(before));
  const prior = incremental && state.preview?.windowId === windowId ? state.preview : null;
  let priorPlan: Plan | null = null;
  if (prior && incremental) {
    if (!previewSnapshot || incremental.draft === null) throw new Error("The current preview draft is missing. Generate a new full preview.");
    validatePreviewGrowth(previewSnapshot, before, targets);
    priorPlan = parsePlan(incremental.draft, prior.tabs, prior.targets);
  } else if (incremental && incremental.draft !== null) {
    throw new Error("The draft does not belong to this window. Generate a new full preview.");
  }
  const seen = new Set(checked);
  const tabs = eligible(incremental ? before.tabs.filter(tab => !seen.has(tab.id)) : before.tabs);
  if (tabs.length > MAX_TABS) throw new Error(`This check has ${tabs.length} eligible tabs. Move some to another window; the limit is ${MAX_TABS}.`);
  if (incremental && !tabs.length) {
    const checkpoints = await prunedCheckedTabs();
    signal.throwIfAborted();
    state.checkedTabs = checkpoints;
    state.status = "No new tabs to check.";
    return;
  }
  const destinations = parseTargets([
    ...targets,
    ...(priorPlan?.groups.flatMap((group, index) => group.targetId === null
      ? [{ id: `draft:${index}`, name: group.name, tabCount: group.tabIds.length }] : []) ?? []),
  ]);
  if (tabs.some(tab => tab.title.length > 2000 || tab.url.length > 4000)) throw new Error("A tab title or address is too long to send. Move that tab to another window first.");
  if (tabs.length && !state.settings.model) throw new Error("Select a model in Settings first.");
  state.status = tabs.length ? `Asking ${state.settings.model} to organize ${tabs.length} tabs…` : "No eligible tabs to classify.";
  await publish();
  const additions = tabs.length
    ? await groupTabs(state.settings, grouping, tabs, destinations, signal)
    : { groups: [], ungrouped: [] };
  signal.throwIfAborted();
  const current = await snapshot(windowId);
  if (!unchanged(before, current) || !sameTargets(targets, parseTargets(await browserTargets(current)))) {
    throw new Error("Tabs or group destinations changed during classification. Try again with a new preview.");
  }
  const combinedTabs = prior ? [...prior.tabs, ...tabs] : tabs;
  const plan = parsePlan(priorPlan ? mergePlan(priorPlan, additions) : additions, combinedTabs, targets);
  const checkpoints = await prunedCheckedTabs();
  signal.throwIfAborted();
  // Classification is complete. Stop accepting cancellation before committing its
  // preferences and checkpoint, so a cancelled request cannot persist preferences.
  controller = null;
  if (incremental) await chrome.storage.local.set({ grouping });
  state.grouping = grouping;
  state.checkedTabs = checkpoints;
  state.checkedTabs[String(windowId)] = [...new Set([...(checkpoints[String(windowId)] ?? []), ...tabs.map(tab => tab.id)])];
  previewSnapshot = before;
  state.preview = { windowId, tabs: combinedTabs, targets, plan };
  state.status = plan.groups.length ? "No tabs changed." : "No related groups were found. Your tabs are unchanged.";
}

async function saveRecovery(saved: Undo) {
  saved.after = await snapshot(saved.before.windowId);
  await chrome.storage.session.set({ undo: saved });
}

async function apply(windowId: number, planValue: Plan) {
  const preview = state.preview;
  const before = previewSnapshot;
  if (!preview || !before) throw new Error("Generate a preview first.");
  if (windowId !== preview.windowId || windowId !== before.windowId) throw new Error("Apply must use the same window as the preview.");
  const plan = parsePlan(planValue, preview.tabs, preview.targets);
  if (!plan.groups.length) throw new Error("Select at least one group to apply.");
  const current = await snapshot(windowId);
  if (!unchanged(before, current) || !sameTargets(preview.targets, parseTargets(await browserTargets(current)))) {
    throw new Error("Tabs or group destinations changed since this preview. Generate a new preview before applying.");
  }
  const saved: Undo = { before, after: before, addedTabIds: [] };
  const expectedTargets = preview.targets.map(target => ({ ...target }));
  const previousUndo = undo;
  undo = saved;
  state.canUndo = true;
  await publish();
  // Recovery records only submitted IDs, never the old members of a destination.
  try {
    for (const group of plan.groups) {
      const current = await snapshot(windowId);
      if (!unchanged(saved.after, current)) throw new Error("Tabs changed during grouping.");
      // New groups may take the browser above the provider's destination limit.
      // Compare known destinations without treating our own creations as input.
      if (!sameTargets(expectedTargets, await browserTargets(current), true)) throw new Error("Group destinations changed during grouping.");
      const groupId = await chrome.tabs.group({ tabIds: group.tabIds as [number, ...number[]],
        ...(group.targetId === null ? { createProperties: { windowId } } : { groupId: Number(group.targetId.slice(8)) }),
      });
      saved.addedTabIds.push(...group.tabIds);
      await saveRecovery(saved);
      if (group.targetId === null) {
        await chrome.tabGroups.update(groupId, { title: group.name, collapsed: false });
        await saveRecovery(saved);
        expectedTargets.push({ id: `browser:${groupId}`, name: group.name, tabCount: group.tabIds.length });
      } else {
        // parsePlan already verified that every browser destination exists.
        expectedTargets.find(target => target.id === group.targetId)!.tabCount += group.tabIds.length;
      }
    }
    state.preview = null;
    previewSnapshot = null;
    state.status = `Applied ${plan.groups.length} ${plan.groups.length === 1 ? "group" : "groups"}. Undo is available until the tabs change.`;
  } catch (error) {
    state.preview = null;
    previewSnapshot = null;
    if (!saved.addedTabIds.length) {
      undo = previousUndo;
      state.canUndo = undo !== null;
      throw error;
    }
    throw new Error("Only some grouping operations completed. Review your tabs; use Undo to restore the previous layout if you have not changed it.");
  }
}

async function undoApply() {
  const saved = undo;
  if (!saved) throw new Error("There is no grouping operation to undo.");
  const mutate = async (change: () => Promise<unknown>) => {
    if (!unchanged(saved.after, await snapshot(saved.before.windowId), false)) {
      throw new Error("Tabs changed after grouping. Undo stopped to preserve your changes.");
    }
    await change();
    await saveRecovery(saved);
  };
  try {
    const added = new Set(saved.addedTabIds);
    const ids = saved.after.tabs.filter(tab => added.has(tab.id) && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE).map(tab => tab.id);
    if (ids.length) await mutate(() => chrome.tabs.ungroup(ids as [number, ...number[]]));
    // Grouping only moved these added IDs. Gather them at the end first, leaving
    // every untouched tab and whole existing group in its original relative order.
    // Then insert in original index order. Ungroup after each move because Chrome
    // can join a moved tab to its neighbor; never ungroup an untouched member.
    const original = saved.before.tabs.filter(tab => added.has(tab.id));
    for (const tab of original) {
      await mutate(() => chrome.tabs.move(tab.id, { index: -1 }));
      await mutate(() => chrome.tabs.ungroup(tab.id));
    }
    for (const tab of original) {
      await mutate(() => chrome.tabs.move(tab.id, { index: tab.index }));
      await mutate(() => chrome.tabs.ungroup(tab.id));
    }
    const restored = await snapshot(saved.before.windowId);
    if (!unchanged(saved.before, restored, false)) throw new Error("The restored layout does not match the pre-apply snapshot.");
    undo = null;
    state.canUndo = false;
    state.status = "Restored the previous tab order and groups.";
  } catch (error) {
    // Keep the last completed mutation recoverable, including an interrupted Undo.
    throw new Error(`${error instanceof Error ? error.message : "Undo could not finish."} Recovery is retained; review your tabs before retrying Undo.`);
  }
}

async function handle(request: Request): Promise<AppState> {
  await ready;
  if (request.type === "getState") {
    if (!state.busy) {
      state.checkedTabs = await prunedCheckedTabs();
      await chrome.storage.session.set({ state });
    }
    return state;
  }
  if (request.type === "cancel") {
    if (!controller) throw new Error("There is no cancellable provider request.");
    controller.abort();
    return state;
  }
  if (state.busy) throw new Error("Wait for the current operation or cancel it first.");
  state.busy = true;
  state.error = null;
  const abort = new AbortController();
  controller = request.type === "loadModels" || request.type === "preview" || request.type === "regroup" ? abort : null;
  // Extension API activity keeps the worker alive while a remote provider streams its response.
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
  try {
    await publish();
    switch (request.type) {
      case "saveSettings": {
        const settings = validateSettings(request.settings);
        if (settings.provider === "api" && !await chrome.permissions.contains({ origins: [new URL(settings.endpoint).origin + "/*"] })) {
          throw new Error("Grant access to the API endpoint before saving.");
        }
        state.settings = settings;
        state.models = [];
        state.preview = null;
        previewSnapshot = null;
        await chrome.storage.local.set({ settings });
        state.status = "Settings saved.";
        break;
      }
      case "saveGrouping":
        state.grouping = parseGrouping(request.grouping);
        state.preview = null;
        previewSnapshot = null;
        await chrome.storage.local.set({ grouping: state.grouping });
        state.status = "Grouping preferences saved.";
        break;
      case "loadModels":
        state.status = "Loading available models…";
        await publish();
        state.models = await listModels(state.settings, abort.signal);
        state.status = `Loaded ${state.models.length} models.`;
        break;
      case "preview": await generate(request.windowId, abort.signal); break;
      case "regroup": await generate(request.windowId, abort.signal, request); break;
      case "apply": await apply(request.windowId, request.plan); break;
      case "undo": await undoApply(); break;
      default: throw new Error("Unknown extension operation.");
    }
  } catch (error) {
    state.error = abort.signal.aborted ? "Cancelled. No grouping changes were applied." : error instanceof Error ? error.message : "The operation failed. Try again.";
    state.status = abort.signal.aborted ? "Cancelled" : "Operation stopped";
  } finally {
    clearInterval(keepAlive);
    controller = null;
    state.busy = false;
    await publish();
  }
  return state;
}

chrome.runtime.onMessage.addListener((request: Request, sender, respond: (reply: Reply) => void) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("panel.html"))) return false;
  void handle(request).then(value => respond({ ok: true, state: value }), error => respond({ ok: false, error: error instanceof Error ? error.message : "The operation failed." }));
  return true;
});
