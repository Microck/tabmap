import { HOST_NAME, SYSTEM_PROMPT, parsePlan, classifyTabs, type GroupTarget, type GroupingPreferences, type Settings, type ModelOption, type TabInput, type Plan } from "./shared";

const TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const CONNECTOR_HELP = "Cannot connect to Codex. Install the native connector for this browser and extension ID with --login to authenticate its dedicated Codex home.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function models(value: unknown): ModelOption[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("The provider returned an invalid model list.");
  const seen = new Set<string>();
  return value.map(item => {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256
        || typeof item.name !== "string" || !item.name.trim() || item.name.length > 512 || seen.has(item.id)) {
      throw new Error("The provider returned an invalid model list.");
    }
    seen.add(item.id);
    return { id: item.id, name: item.name };
  });
}

type NativePayload = { method: "models" } | { method: "group"; model: string; tabs: TabInput[]; grouping: GroupingPreferences; targets: GroupTarget[] };

function nativeRequest(request: NativePayload, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  let port: chrome.runtime.Port;
  try { port = chrome.runtime.connectNative(HOST_NAME); }
  catch { return Promise.reject(new Error(CONNECTOR_HELP)); }
  const id = crypto.randomUUID();
  let finished = false;
  const finish = (error: Error | null, result?: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    port.onMessage.removeListener(receive);
    port.onDisconnect.removeListener(disconnect);
    port.disconnect();
    if (error) reject(error); else resolve(result);
  };
  const abort = () => finish(new DOMException("Request cancelled.", "AbortError"));
  const timer = setTimeout(() => finish(new Error("Codex timed out after 120 seconds. Try fewer tabs or another model.")), TIMEOUT_MS);
  const disconnect = () => {
    // Reading lastError consumes Chrome's diagnostic; never forward its raw text.
    void chrome.runtime.lastError;
    finish(new Error(CONNECTOR_HELP));
  };
  const receive = (message: unknown) => {
    if (!record(message) || message.id !== id || typeof message.ok !== "boolean") {
      finish(new Error("The Codex connector returned an invalid response. Reinstall the connector."));
    } else if (message.ok) {
      finish(null, message.result);
    } else {
      finish(new Error(typeof message.error === "string" && message.error.length <= 1_000
        ? message.error : "Codex failed. Check your Codex login and selected model."));
    }
  };
  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(disconnect);
  signal.addEventListener("abort", abort, { once: true });
  try { port.postMessage({ id, ...request }); }
  catch { finish(new Error(CONNECTOR_HELP)); }
  return promise;
}

async function apiRequest(settings: Extract<Settings, { provider: "api" }>, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  let base: URL;
  try { base = new URL(settings.endpoint); }
  catch { throw new Error("Enter a valid API base URL, including https://."); }
  const loopback = base.hostname === "localhost" || base.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("Use an HTTPS API base URL without credentials, query, or fragment. HTTP is allowed only on loopback.");
  }
  if (!settings.apiKey.trim()) throw new Error("Enter an API key for this endpoint.");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${path}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const response = await fetch(base.href, {
      method: body === undefined ? "GET" : "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${settings.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`API request failed (HTTP ${response.status}). Check the endpoint, API key, model access, and provider quota.`);
    }
    if (!response.body) throw new Error("The API returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("The API response exceeded the 1 MiB limit.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); }
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("The API did not return valid JSON."); }
  } catch (error) {
    if (signal.aborted) throw new DOMException("Request cancelled.", "AbortError");
    if (controller.signal.aborted) throw new Error("The API timed out after 120 seconds. Try fewer tabs or another model.");
    if (error instanceof Error && /^The API |^API request failed/.test(error.message)) throw error;
    throw new Error("Cannot reach the API. Check its URL, host permission, TLS, and network connection. Redirects are not allowed.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function listModels(settings: Settings, signal: AbortSignal): Promise<ModelOption[]> {
  if (settings.provider === "codex") return models(await nativeRequest({ method: "models" }, signal));
  const response = await apiRequest(settings, "models", signal);
  if (!record(response) || !Array.isArray(response.data)) throw new Error("The API returned an invalid model list. Enter a model ID manually if discovery is unsupported.");
  return models(response.data.map((item: unknown) => record(item) ? { id: item.id, name: item.id } : item));
}

export async function groupTabs(settings: Settings, grouping: GroupingPreferences, tabs: TabInput[], targets: GroupTarget[], signal: AbortSignal): Promise<Plan> {
  if (!settings.model.trim()) throw new Error("Choose a model before creating a preview.");
  if (settings.provider === "codex") return parsePlan(await nativeRequest({ method: "group", model: settings.model, tabs, grouping, targets }, signal), tabs, targets);
  return classifyTabs(tabs, grouping, targets, async input => {
    const response = await apiRequest(settings, "chat/completions", signal, {
      model: settings.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: JSON.stringify(input) }],
    });
    if (!record(response) || !Array.isArray(response.choices) || !record(response.choices[0])) throw new Error("The API returned no completion.");
    const choice = response.choices[0];
    if (choice.finish_reason !== "stop" || !record(choice.message) || typeof choice.message.content !== "string" || choice.message.tool_calls) {
      throw new Error("The API did not return a complete text answer. Choose a Chat Completions model with sufficient output capacity.");
    }
    try { return JSON.parse(choice.message.content) as unknown; }
    catch { throw new Error("The model did not return strict JSON. No tabs were changed."); }
  });
}
