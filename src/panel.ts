import { parseGrouping, parsePlan, type AppState, type GroupingPreferences, type Plan, type Preview, type Reply, type Request, type Settings, type TabInput } from "./shared";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing panel element: ${id}`);
  return node as T;
}

const settingsForm = element<HTMLFormElement>("settings-form");
const settingsFields = element<HTMLFieldSetElement>("settings-fields");
const provider = element<HTMLSelectElement>("provider");
const endpoint = element<HTMLInputElement>("endpoint");
const apiKey = element<HTMLInputElement>("api-key");
const apiModel = element<HTMLInputElement>("api-model");
const codexModel = element<HTMLSelectElement>("codex-model");
const loadModels = element<HTMLButtonElement>("load-models");
const previewButton = element<HTMLButtonElement>("preview");
const regroupButton = element<HTMLButtonElement>("regroup");
const applyButton = element<HTMLButtonElement>("apply");
const undoButton = element<HTMLButtonElement>("undo");
const cancelButton = element<HTMLButtonElement>("cancel");
const planFields = element<HTMLFieldSetElement>("plan-fields");
const groupingForm = element<HTMLFormElement>("grouping-form");
const groupingFields = element<HTMLFieldSetElement>("grouping-fields");
const instructions = element<HTMLTextAreaElement>("instructions");
const editDialog = element<HTMLDialogElement>("edit-dialog");
const editTarget = element<HTMLSelectElement>("edit-target");
const status = element<HTMLParagraphElement>("status");
const error = element<HTMLParagraphElement>("error");
let state: AppState | undefined;
let dirty = false;
let groupingDirty = false;
let pending = false;
let cancelling = false;
let requestGeneration = 0;
let previewSignature = "";
let modelSignature = "";
interface DraftGroup { key: number; name: string; tabIds: number[]; targetId: string | null; included: boolean }
let draft: { groups: DraftGroup[]; ungrouped: number[] } | null = null;
let editing: { kind: "move"; tabId: number } | { kind: "merge"; groupKey: number } | null = null;
let currentWindowId: number | undefined;
let nextGroupKey = 0;
let editorTrigger: HTMLElement | null = null;

function currentPreview(): Preview | null {
  return currentWindowId !== undefined && state?.preview?.windowId === currentWindowId ? state.preview : null;
}

function revealPreview(): void {
  const heading = element("plan-heading");
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "start", behavior: "instant" });
}

function showError(message: string): void {
  error.textContent = message;
}

function readSettings(): Settings {
  return provider.value === "api"
    ? { provider: "api", endpoint: endpoint.value.trim(), apiKey: apiKey.value, model: apiModel.value.trim() }
    : { provider: "codex", model: codexModel.value };
}

function readGrouping(): GroupingPreferences {
  return parseGrouping({
    detail: groupingForm.querySelector<HTMLInputElement>('input[name="detail"]:checked')?.value,
    instructions: instructions.value,
  });
}

function updateProviderFields(): void {
  const api = provider.value === "api";
  element("api-fields").hidden = !api;
  element("codex-fields").hidden = api;
  endpoint.required = api;
  endpoint.disabled = !api;
}

function renderModels(): void {
  if (!state) return;
  const signature = JSON.stringify([state.settings.provider, state.models, state.settings.model]);
  if (signature === modelSignature) return;
  modelSignature = signature;
  const selected = codexModel.value;
  codexModel.replaceChildren(new Option("Choose a model", ""));
  element("api-models").replaceChildren();
  for (const model of state.models) {
    if (state.settings.provider === "codex") codexModel.add(new Option(model.name, model.id));
    else element("api-models").append(new Option(model.name, model.id));
  }
  // Keep a saved selection visible before discovery, without inventing a model list.
  if (state.settings.provider === "codex" && state.settings.model
      && !state.models.some(model => model.id === state?.settings.model)) {
    codexModel.add(new Option(`${state.settings.model} (saved)`, state.settings.model));
  }
  codexModel.value = dirty ? selected : state.settings.provider === "codex" ? state.settings.model : "";
}

function tabList(ids: number[], tabs: Map<number, TabInput>): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "tab-list";
  for (const id of ids) {
    const tab = tabs.get(id);
    if (!tab) continue;
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = tab.title || "Untitled tab";
    const host = document.createElement("span");
    host.className = "sr-only";
    host.textContent = ` (${new URL(tab.url).host})`;
    const text = document.createElement("span");
    text.className = "tab-text";
    text.title = tab.url;
    text.append(title, host);
    const move = document.createElement("button");
    move.type = "button";
    move.textContent = "Move";
    move.setAttribute("aria-label", `Move ${tab.title || "untitled tab"}`);
    move.disabled = !draft?.groups.length && !currentPreview()?.targets.length;
    move.addEventListener("click", () => openEditor({ kind: "move", tabId: id }));
    item.className = "tab-row";
    item.append(text, move);
    list.append(item);
  }
  return list;
}

function renderPreview(preview: Preview | null): void {
  const signature = JSON.stringify(preview);
  if (signature === previewSignature) return;
  previewSignature = signature;
  if (editDialog.open) editDialog.close();
  draft = preview ? {
    groups: preview.plan.groups.map(group => ({ ...group, tabIds: [...group.tabIds], key: nextGroupKey++, included: true })),
    ungrouped: [...preview.plan.ungrouped],
  } : null;
  renderDraft();
}

function renderDraft(): void {
  const groups = element("groups");
  const ungrouped = element("ungrouped");
  groups.replaceChildren();
  ungrouped.replaceChildren();
  const summary = element("plan-summary");
  const preview = currentPreview();
  element("preview-empty").hidden = Boolean(draft && preview);
  if (!draft || !preview) {
    summary.textContent = "";
    updateControls();
    return;
  }
  summary.textContent = draft.groups.length ? `${draft.groups.length} ${draft.groups.length === 1 ? "group" : "groups"}` : "No groups. These tabs will stay ungrouped.";
  const tabs = new Map(preview.tabs.map(tab => [tab.id, tab]));
  for (const group of draft.groups) {
    const container = document.createElement("div");
    container.className = "group";
    container.dataset.groupKey = String(group.key);
    const includeLabel = document.createElement("label");
    includeLabel.className = "group-include";
    const include = document.createElement("input");
    include.type = "checkbox";
    include.checked = group.included;
    include.setAttribute("aria-label", `Include ${group.name}`);
    const includeText = document.createElement("span");
    includeText.className = "group-count";
    includeText.textContent = group.targetId === null
      ? `${group.tabIds.length} tabs`
      : `${group.tabIds.length} added`;
    includeLabel.append(include);
    const nameLabel = document.createElement("label");
    nameLabel.className = "sr-only";
    nameLabel.htmlFor = `group-name-${group.key}`;
    nameLabel.textContent = group.targetId === null ? "Group name" : "Existing group";
    const name = document.createElement("input");
    name.id = nameLabel.htmlFor;
    name.type = "text";
    name.maxLength = group.targetId === null ? 80 : 2000;
    name.required = true;
    name.value = group.name;
    name.readOnly = group.targetId !== null;
    name.disabled = !group.included;
    include.addEventListener("change", () => {
      group.included = include.checked;
      name.disabled = !include.checked;
      updateControls();
    });
    name.addEventListener("input", () => {
      group.name = name.value;
      name.setCustomValidity("");
      include.setAttribute("aria-label", `Include ${group.name}`);
      merge.setAttribute("aria-label", `Merge ${group.name}`);
    });
    const merge = document.createElement("button");
    merge.type = "button";
    merge.textContent = "Merge";
    merge.setAttribute("aria-label", `Merge ${group.name}`);
    merge.disabled = draft.groups.length < 2;
    merge.addEventListener("click", () => openEditor({ kind: "merge", groupKey: group.key }));
    const heading = document.createElement("div");
    heading.className = "group-heading";
    heading.append(includeLabel, nameLabel, name, includeText, merge);
    container.append(heading);
    if (group.targetId !== null) {
      const prior = document.createElement("p");
      const target = preview.targets.find(target => target.id === group.targetId);
      prior.id = `group-existing-${group.key}`;
      prior.className = "sr-only";
      prior.textContent = `${target!.tabCount} existing members stay grouped.`;
      name.setAttribute("aria-describedby", prior.id);
      name.title = prior.textContent;
      container.append(prior);
    }
    container.append(tabList(group.tabIds, tabs));
    groups.append(container);
  }
  if (draft.ungrouped.length) {
    const details = document.createElement("details");
    const heading = document.createElement("summary");
    heading.textContent = `${draft.ungrouped.length} ungrouped`;
    details.append(heading, tabList(draft.ungrouped, tabs));
    ungrouped.append(details);
  }
  updateControls();
}

function openEditor(action: NonNullable<typeof editing>): void {
  const preview = currentPreview();
  if (!draft || !preview) return;
  editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editing = action;
  const source = action.kind === "merge"
    ? draft.groups.find(group => group.key === action.groupKey)
    : draft.groups.find(group => group.tabIds.includes(action.tabId));
  element("edit-heading").textContent = action.kind === "merge" ? "Merge group" : "Move tab";
  element("edit-source").textContent = action.kind === "merge"
    ? source!.name : preview.tabs.find(tab => tab.id === action.tabId)!.title;
  element("edit-confirm").textContent = action.kind === "merge" ? "Merge" : "Move";
  const placeholder = new Option("Choose a destination", "");
  placeholder.disabled = true;
  editTarget.replaceChildren(placeholder);
  editTarget.required = true;
  if (action.kind === "move" && source) editTarget.add(new Option("Ungrouped", "ungrouped"));
  for (const group of draft.groups) {
    if (group !== source) editTarget.add(new Option(
      `${group.name || "Unnamed group"}${group.targetId === null ? "" : " (existing group)"}`,
      `draft:${group.key}`,
    ));
  }
  if (action.kind === "move") {
    for (const target of preview.targets) {
      if (draft.groups.some(group => group.targetId === target.id)) continue;
      editTarget.add(new Option(`${target.name} (existing group, ${target.tabCount} tabs)`, target.id));
    }
  }
  editTarget.value = "";
  editDialog.showModal();
}

element<HTMLFormElement>("edit-form").addEventListener("submit", event => {
  event.preventDefault();
  const preview = currentPreview();
  if (!draft || !editing || !preview || element<HTMLButtonElement>("edit-confirm").disabled) return;
  if (!editTarget.reportValidity()) return;
  const action = editing;
  let target = draft.groups.find(group => `draft:${group.key}` === editTarget.value);
  if (!target && action.kind === "move" && editTarget.value !== "ungrouped") {
    const destination = preview.targets.find(target => target.id === editTarget.value);
    if (!destination) return;
    target = { key: nextGroupKey++, name: destination.name, targetId: destination.id, tabIds: [], included: true };
    draft.groups.push(target);
  }
  if (action.kind === "merge") {
    const source = draft.groups.find(group => group.key === action.groupKey);
    if (!source || !target || source === target) return;
    target.tabIds.push(...source.tabIds);
    draft.groups = draft.groups.filter(group => group !== source);
    status.textContent = `Merged into ${target.name}.`;
  } else {
    const tabId = action.tabId;
    const source = draft.groups.find(group => group.tabIds.includes(tabId));
    if (source) source.tabIds = source.tabIds.filter(id => id !== tabId);
    else draft.ungrouped = draft.ungrouped.filter(id => id !== tabId);
    if (target) target.tabIds.push(tabId);
    else draft.ungrouped.push(tabId);
    const lone = source?.targetId === null && source.tabIds.length === 1;
    if (source && (source.tabIds.length === 0 || lone)) {
      draft.ungrouped.push(...source.tabIds);
      draft.groups = draft.groups.filter(group => group !== source);
    }
    status.textContent = `Tab moved to ${target?.name || "Ungrouped"}.${lone ? " The remaining tab is ungrouped." : ""}`;
  }
  editDialog.close();
  renderDraft();
  element("plan-heading").focus();
});
element("edit-cancel").addEventListener("click", () => editDialog.close());
editDialog.addEventListener("close", () => {
  editing = null;
  if (editorTrigger?.isConnected) editorTrigger.focus();
  else element("plan-heading").focus();
  editorTrigger = null;
});

function readDraft(): Plan | null {
  const preview = currentPreview();
  if (!draft || !preview) return null;
  const plan: Plan = { groups: [], ungrouped: [...draft.ungrouped] };
  for (const group of draft.groups) {
    if (!group.included) {
      plan.ungrouped.push(...group.tabIds);
      continue;
    }
    const name = group.targetId === null ? group.name.trim() : group.name;
    if (!name) {
      const field = element<HTMLInputElement>(`group-name-${group.key}`);
      field.setCustomValidity("Enter a group name or uncheck this group.");
      field.reportValidity();
      throw new Error("Enter a group name or uncheck this group.");
    }
    plan.groups.push({ name, targetId: group.targetId, tabIds: group.tabIds });
  }
  return parsePlan(plan, preview.tabs, preview.targets);
}

function updateControls(): void {
  const running = Boolean(state?.busy);
  const busy = pending || running;
  const unavailable = !state || busy;
  const stale = dirty || groupingDirty;
  const modelMissing = !state?.settings.model;
  groupingForm.hidden = modelMissing;
  element("review-section").hidden = modelMissing && !currentPreview();
  settingsFields.disabled = unavailable;
  groupingFields.disabled = unavailable;
  planFields.disabled = unavailable || stale;
  loadModels.disabled = busy || dirty;
  previewButton.disabled = unavailable || dirty || modelMissing || currentWindowId === undefined;
  regroupButton.disabled = previewButton.disabled || !state?.checkedTabs[String(currentWindowId)];
  applyButton.disabled = !currentPreview() || !draft?.groups.some(group => group.included) || busy || stale;
  undoButton.disabled = !state?.canUndo || busy;
  cancelButton.hidden = !running;
  cancelButton.disabled = cancelling;
  cancelButton.textContent = cancelling ? "Cancelling…" : "Cancel";
  element("grouping-notice").hidden = !groupingDirty;
  element<HTMLButtonElement>("edit-confirm").disabled = busy || stale;
  element("settings-hint").textContent = dirty
    ? "Save connection changes first."
    : "";
}

function render(next: AppState): void {
  const first = !state;
  state = next;
  renderModels();
  if (!dirty) {
    provider.value = next.settings.provider;
    if (next.settings.provider === "api") {
      endpoint.value = next.settings.endpoint;
      apiKey.value = next.settings.apiKey;
      apiModel.value = next.settings.model;
    } else codexModel.value = next.settings.model;
  }
  if (!groupingDirty) {
    for (const radio of groupingForm.querySelectorAll<HTMLInputElement>('input[name="detail"]')) radio.checked = radio.value === next.grouping.detail;
    instructions.value = next.grouping.instructions;
  }
  updateProviderFields();
  if (first && !next.settings.model) element<HTMLDetailsElement>("settings-details").open = true;
  status.textContent = next.status || (next.busy ? "Working…" : "");
  showError(next.error || "");
  element("provider-summary").textContent = next.settings.model;
  element("provider-summary").title = next.settings.model;
  renderPreview(currentPreview());
  updateControls();
}

async function send(request: Request): Promise<AppState> {
  const reply: Reply = await chrome.runtime.sendMessage(request);
  if (!reply.ok) throw new Error(reply.error);
  return reply.state;
}

async function run(action: () => Promise<AppState>): Promise<boolean> {
  if (pending || state?.busy) return false;
  const generation = ++requestGeneration;
  pending = true;
  showError("");
  updateControls();
  try {
    const next = await action();
    if (generation !== requestGeneration) return false;
    render(next);
    return !next.error;
  } catch (cause) {
    if (generation === requestGeneration) showError(cause instanceof Error ? cause.message : "The operation failed. Reopen the panel and try again.");
    return false;
  } finally {
    if (generation === requestGeneration) {
      pending = false;
      updateControls();
    }
  }
}

settingsForm.addEventListener("input", () => {
  dirty = true;
  updateProviderFields();
  updateControls();
});
settingsForm.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => {
    const settings = readSettings();
    if (settings.provider === "api") {
      let url: URL;
      try { url = new URL(settings.endpoint); }
      catch { throw new Error("Enter a valid API base URL, such as https://api.example.com/v1."); }
      const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
        throw new Error("Use HTTPS or loopback HTTP, without credentials in the URL.");
      }
      // This runs before any other await, retaining the save gesture for Chrome's permission prompt.
      const granted = await chrome.permissions.request({ origins: [url.origin + "/*"] });
      if (!granted) throw new Error("Host access was not granted. Settings were not saved. Allow access to use this API.");
    }
    const next = await send({ type: "saveSettings", settings });
    dirty = false;
    return next;
  });
});
loadModels.addEventListener("click", () => { void run(() => send({ type: "loadModels" })); });
groupingForm.addEventListener("input", () => {
  const detail = groupingForm.querySelector<HTMLInputElement>('input[name="detail"]:checked')?.value;
  groupingDirty = !state || detail !== state.grouping.detail || instructions.value.trim() !== state.grouping.instructions;
  updateControls();
});
instructions.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    groupingForm.requestSubmit();
  }
});
groupingForm.addEventListener("submit", event => {
  event.preventDefault();
  const windowId = currentWindowId;
  if (previewButton.disabled || windowId === undefined) return;
  void run(async () => {
    if (groupingDirty) {
      const saved = await send({ type: "saveGrouping", grouping: readGrouping() });
      if (saved.error) throw new Error(saved.error);
      groupingDirty = false;
    }
    return send({ type: "preview", windowId });
  }).then(completed => {
    if (completed && currentPreview()) revealPreview();
  });
});
regroupButton.addEventListener("click", () => {
  const windowId = currentWindowId;
  if (regroupButton.disabled || windowId === undefined) return;
  let plan: Plan | null;
  let grouping: GroupingPreferences;
  try {
    plan = readDraft();
    grouping = readGrouping();
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : "Review the draft and grouping preferences.");
    return;
  }
  const previousSignature = previewSignature;
  void run(async () => {
    // Save preferences only as part of a successful incremental check.
    const next = await send({ type: "regroup", windowId, draft: plan, grouping });
    if (!next.error) {
      groupingDirty = next.grouping.detail !== grouping.detail || next.grouping.instructions !== grouping.instructions;
    }
    return next;
  }).then(completed => {
    if (completed && currentPreview() && previewSignature !== previousSignature) revealPreview();
  });
});
element<HTMLFormElement>("plan-form").addEventListener("submit", event => {
  event.preventDefault();
  const windowId = currentWindowId;
  if (applyButton.disabled || windowId === undefined) return;
  let plan: Plan | null;
  try {
    plan = readDraft();
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : "Review the draft before applying groups.");
    return;
  }
  if (plan) void run(() => send({ type: "apply", windowId, plan }));
});
undoButton.addEventListener("click", () => { void run(() => send({ type: "undo" })); });
cancelButton.addEventListener("click", () => {
  if (cancelling) return;
  cancelling = true;
  // Ignore the interrupted operation's eventual reply, not the background's state broadcasts.
  ++requestGeneration;
  updateControls();
  void send({ type: "cancel" }).then(render).catch(cause => {
    showError(cause instanceof Error ? cause.message : "Cancellation failed. Reopen the panel to check the operation.");
  }).finally(() => {
    pending = false;
    cancelling = false;
    updateControls();
  });
});
chrome.runtime.onMessage.addListener((message: { type?: string; state?: AppState }) => {
  if (message.type === "state" && message.state) render(message.state);
});
element("extension-id").textContent = chrome.runtime.id;
element("install-command").textContent = `node install.js --extension-id ${chrome.runtime.id} --browser chrome --login`;
void run(async () => {
  const window = await chrome.windows.getCurrent();
  if (window.id === undefined) throw new Error("The current window is unavailable. Reopen this panel in a browser window.");
  currentWindowId = window.id;
  return send({ type: "getState" });
});
