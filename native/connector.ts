import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MAX_TABS, SYSTEM_PROMPT, classifyTabs, parseGrouping, parseTargets, type GroupTarget, type GroupingPreferences, type ModelOption, type Plan, type TabInput } from "../src/shared";

const MAX_FRAME = 1_048_576;
const TIMEOUT_MS = 120_000;
const LITTLE_ENDIAN = endianness() === "LE";
// Verified against rust-v0.166.0/config.schema.json. Named permissions compile
// from deny-by-default filesystem/network policies. Empty environments also
// prevent file tools from resolving an executor before touching any path.
export const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "shell_snapshot_v2", "js_repl",
  "browser_use", "browser_use_external", "in_app_browser", "apps", "enable_mcp_apps",
  "plugins", "plugin_hooks", "plugin_discovery_prefetch", "remote_plugin",
  "hooks", "codex_hooks", "multi_agent", "multi_agent_v2", "collab",
  "code_mode", "code_mode_host", "code_mode_tool_search", "tool_search", "tool_suggest",
  "view_image", "image_generation", "imagegenext", "memory_tool", "memories",
  "skill_search", "skill_mcp_dependency_install", "request_permissions_tool",
  "deferred_executor", "external_agent_memory_import", "search_tool",
  "computer_use", "standalone_web_search", "realtime_conversation", "remote_control", "send_message_to_user_async",
] as const;
export const ISOLATION_CONFIG: Record<string, unknown> = {
  ...Object.fromEntries(DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
  "features.skip_host_skill_discovery": true,
  "features.omit_skill_descriptions": true,
  "agents.enabled": false,
  "tools.update_plan.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
  developer_instructions: "",
  notify: [],
  approval_policy: "never",
  "analytics.enabled": false,
  "otel.exporter": "none",
  "otel.trace_exporter": "none",
  "otel.metrics_exporter": "none",
  approvals_reviewer: "user",
};

type NativeRequest = { id: string; method: "models" } | { id: string; method: "group"; model: string; grouping: GroupingPreferences; tabs: TabInput[]; targets: GroupTarget[] };
interface NativeResult {
  result: ModelOption[] | Plan;
  inspection?: { confirmedPermissionProfile: string; requestedEnvironments: []; confirmedInstructionSources: []; mcpDisableOverrides: number; confirmedDisabledFeatures: readonly string[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequest(value: unknown): NativeRequest {
  if (!record(value) || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)
      || (value.method !== "models" && value.method !== "group")) throw new Error("Invalid connector request.");
  const keys = value.method === "models" ? ["id", "method"] : ["id", "method", "model", "grouping", "tabs", "targets"];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unexpected connector request field.");
  if (value.method === "group") {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 256
        || !Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > MAX_TABS) throw new Error("Choose a model and send between 1 and 400 tabs.");
    const ids = new Set<number>();
    for (const tab of value.tabs) {
      if (!record(tab) || typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 0 || ids.has(tab.id)
          || typeof tab.title !== "string" || tab.title.length > 8_192 || typeof tab.url !== "string" || tab.url.length > 16_384
          || Object.keys(tab).some(key => !["id", "title", "url"].includes(key))) throw new Error("Invalid tab metadata.");
      let url: URL;
      try { url = new URL(tab.url); } catch { throw new Error("Invalid tab URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Tab URLs must be HTTP(S) without credentials, queries, or fragments.");
      ids.add(tab.id);
    }
    return { id: value.id, method: "group", model: value.model, grouping: parseGrouping(value.grouping), tabs: value.tabs as TabInput[], targets: parseTargets(value.targets) };
  }
  return { id: value.id, method: "models" };
}

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME) throw new Error("Connector response exceeded the size limit.");
  const prefix = Buffer.allocUnsafe(4);
  if (LITTLE_ENDIAN) prefix.writeUInt32LE(body.length); else prefix.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([prefix, body]));
}

async function runCodex(codexPath: string, codexHome: string, signal: AbortSignal, nativeRequest: NativeRequest): Promise<NativeResult> {
  const scratch = await mkdtemp(join(tmpdir(), "tab-organizer-"));
  const workspace = join(scratch, "workspace");
  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let fault: Error | undefined;
  let onNotification: ((message: Record<string, unknown>) => void) | undefined;
  let turnFailure: ((error: Error) => void) | undefined;
  const fail = (error: Error) => {
    fault = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    turnFailure?.(error);
    child?.kill("SIGKILL");
  };
  const abort = () => fail(new Error("Codex request cancelled or timed out."));
  try {
    signal.throwIfAborted();
    const profile = `tab-organizer-${crypto.randomUUID()}`;
    await mkdir(workspace, { mode: 0o700 });
    const instructionsFile = join(scratch, "instructions.txt");
    await writeFile(instructionsFile, SYSTEM_PROMPT, { mode: 0o600 });
    const config: Record<string, unknown> = {
      ...ISOLATION_CONFIG,
      model_provider: "openai",
      default_permissions: profile,
      [`permissions.${profile}`]: { filesystem: {}, network: { enabled: false } },
      model_instructions_file: instructionsFile,
      experimental_compact_prompt_file: instructionsFile,
      log_dir: join(scratch, "logs"),
    };
    // Values here are simple TOML scalars, arrays, or a fixed inline table.
    const args = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${key === `permissions.${profile}`
      ? "{ filesystem = {}, network = { enabled = false } }" : JSON.stringify(value)}`]);
    const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
    for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "PATH", "TMPDIR", "TMP", "TEMP"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    signal.throwIfAborted();
    child = spawn(codexPath, ["app-server", "--listen", "stdio://", ...args], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.resume(); // Drain without retaining or logging potentially sensitive output.
    child.on("error", () => fail(new Error("Cannot start Codex. Reinstall the connector with an absolute --codex-path to the Codex executable.")));
    child.on("exit", () => fail(new Error("Codex exited before responding. Check that your Codex installation supports app-server and rerun the connector installer with --login.")));
    child.stdin.on("error", () => fail(new Error("Codex closed its input connection. Check your Codex installation.")));
    let buffered = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_FRAME * 4) { fail(new Error("Codex response exceeded the size limit.")); return; }
      let newline: number;
      while ((newline = buffered.indexOf(10)) !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        try {
          const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (!record(message)) throw new Error();
          if (typeof message.method === "string" && "id" in message) {
            // No approvals, dynamic tools, authentication refresh tokens, or
            // other server-initiated requests are serviced by this connector.
            child?.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Request denied by Tabmap." } })}\n`);
            fail(new Error("Codex requested an operation that this connector does not allow."));
            return;
          }
          if (typeof message.id === "number") {
            const request = pending.get(message.id);
            if (!request) continue;
            pending.delete(message.id);
            if ("error" in message) request.reject(new Error("Codex rejected the isolated request. Check your login, model access, and Codex version."));
            else request.resolve(message.result);
          }
          if (typeof message.method === "string") onNotification?.(message);
        } catch { fail(new Error("Codex returned an invalid protocol response. Update Codex and reinstall the connector.")); return; }
      }
    });
    const rpc = (method: string, params: unknown): Promise<unknown> => {
      if (fault) return Promise.reject(fault);
      const id = ++sequence;
      const request = Promise.withResolvers<unknown>();
      pending.set(id, request);
      child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return request.promise;
    };
    await rpc("initialize", { clientInfo: { name: "tab_organizer", title: "Tabmap", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const account = await rpc("account/read", { refreshToken: false });
    if (!record(account) || !record(account.account) || account.account.type !== "chatgpt") {
      throw new Error("Codex connector login is required. Run the connector installer with --login to sign in to its dedicated Codex home.");
    }
    if (nativeRequest.method === "group") {
      // Empty-table CLI overrides merge with user tables rather than replacing
      // them. Disable every configured MCP server explicitly before any thread.
      const response = await rpc("config/read", { includeLayers: false, cwd: workspace });
      if (!record(response) || !record(response.config)) throw new Error("Codex did not return effective configuration for isolation checks.");
      const effective = response.config;
      if (!record(effective.features) || !record(effective.agents) || effective.agents.enabled !== false
          || effective.web_search !== "disabled" || effective.project_doc_max_bytes !== 0) {
        throw new Error("Codex did not apply the required tool and instruction restrictions.");
      }
      for (const feature of DISABLED_FEATURES) {
        const value = effective.features[feature];
        if (value !== false && !(record(value) && value.enabled === false)) {
          throw new Error("Codex did not disable a required tool feature. Update Codex before grouping tabs.");
        }
      }
      const profiles = effective.permissions;
      const permission = record(profiles) ? profiles[profile] : undefined;
      if (!record(permission) || permission.extends != null || !record(permission.filesystem)
          || Object.entries(permission.filesystem).some(([key, value]) => key !== "glob_scan_max_depth" || value !== null)
          || !record(permission.network) || permission.network.enabled !== false) {
        throw new Error("Codex did not apply the deny-all permission profile. No inference was started.");
      }
      const configuredServers = effective.mcp_servers;
      if (configuredServers !== undefined && !record(configuredServers)) throw new Error("Codex returned invalid MCP configuration.");
      const servers = Object.keys(configuredServers ?? {});
      const mcpOverrides: Record<string, unknown> = {};
      for (const server of servers) {
        if (!/^[a-zA-Z0-9_-]+$/.test(server)) throw new Error("Codex MCP server names must use letters, numbers, hyphens, or underscores for safe isolation.");
        mcpOverrides[`mcp_servers.${server}.enabled`] = false;
      }
      const started = await rpc("thread/start", {
        model: nativeRequest.model, modelProvider: "openai", cwd: workspace,
        ephemeral: true, permissions: profile, approvalPolicy: "never", approvalsReviewer: "user",
        baseInstructions: SYSTEM_PROMPT, developerInstructions: "", environments: [], dynamicTools: [],
        config: { ...config, ...mcpOverrides },
      });
      if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string"
          || started.model !== nativeRequest.model || started.approvalPolicy !== "never" || started.approvalsReviewer !== "user"
          || !record(started.activePermissionProfile) || started.activePermissionProfile.id !== profile
          || started.activePermissionProfile.extends != null || !Array.isArray(started.instructionSources) || started.instructionSources.length !== 0) {
        throw new Error("Codex did not confirm the requested isolation settings. No inference was started.");
      }
      const threadId = started.thread.id;
      const result = await classifyTabs(nativeRequest.tabs, nativeRequest.grouping, nativeRequest.targets, async (input, outputSchema) => {
        const completion = Promise.withResolvers<unknown>();
        // Install before turn/start: a fast server can finish before its RPC reply.
        turnFailure = completion.reject;
        const finalAnswers: string[] = [];
        onNotification = message => {
          if (!record(message.params) || message.params.threadId !== threadId) return;
          const params = message.params;
          if ((message.method === "item/started" || message.method === "item/completed") && record(params.item)
              && !["userMessage", "agentMessage", "reasoning"].includes(String(params.item.type))) {
            fail(new Error("Codex attempted a tool operation. The isolated grouping request was stopped."));
            return;
          }
          if (message.method === "item/completed" && record(params.item) && params.item.type === "agentMessage"
              && params.item.phase !== "commentary") {
            if (typeof params.item.text !== "string" || Buffer.byteLength(params.item.text, "utf8") > MAX_FRAME || finalAnswers.length !== 0) {
              fail(new Error("Codex returned an invalid final answer."));
              return;
            }
            finalAnswers.push(params.item.text);
          }
          if (message.method !== "turn/completed") return;
          if (!record(params.turn) || params.turn.status !== "completed" || !Array.isArray(params.turn.items)) {
            completion.reject(new Error("Codex could not complete grouping. Check model access and account limits."));
            return;
          }
          const answer = finalAnswers[0];
          if (typeof answer !== "string") {
            completion.reject(new Error("Codex did not return one final grouping answer."));
            return;
          }
          try { completion.resolve(JSON.parse(answer) as unknown); }
          catch { completion.reject(new Error("Codex returned invalid JSON. No tabs were changed.")); }
        };
        // Attach rejection before awaiting the RPC to handle early terminal errors.
        const turn = rpc("turn/start", {
          threadId, input: [{ type: "text", text: JSON.stringify(input), text_elements: [] }],
          environments: [], permissions: profile, approvalPolicy: "never", approvalsReviewer: "user", outputSchema,
        });
        const [, answer] = await Promise.all([turn, completion.promise]);
        return answer;
      });
      return { result, inspection: { confirmedPermissionProfile: profile, requestedEnvironments: [], confirmedInstructionSources: [], mcpDisableOverrides: servers.length, confirmedDisabledFeatures: DISABLED_FEATURES } };
    }
    const models: ModelOption[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await rpc("model/list", { limit: 100, cursor, includeHidden: false });
      if (!record(page) || !Array.isArray(page.data)) throw new Error("Codex returned an invalid model list.");
      for (const model of page.data) {
        if (!record(model) || typeof model.model !== "string" || !model.model.trim() || model.model.length > 256
            || typeof model.displayName !== "string" || !model.displayName.trim() || model.displayName.length > 512 || seen.has(model.model)) throw new Error("Codex returned invalid model metadata.");
        seen.add(model.model);
        models.push({ id: model.model, name: model.displayName });
      }
      if (models.length > 10_000 || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new Error("Codex returned invalid model pagination.");
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (!cursor || cursors.has(cursor)) throw new Error("Codex repeated a model-list page.");
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return { result: models };
  } finally {
    signal.removeEventListener("abort", abort);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = Promise.withResolvers<void>();
      child.once("close", () => closed.resolve());
      child.kill("SIGKILL");
      await closed.promise;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [flag, allowedId, codexFlag, codexPath, homeFlag, codexHome, origin, ...extra] = process.argv.slice(2);
  if (Number(process.versions.node.split(".")[0]) < 22 || flag !== "--extension-id" || !allowedId || !/^[a-p]{32}$/.test(allowedId)
      || codexFlag !== "--codex-path" || !codexPath || !isAbsolute(codexPath)
      || homeFlag !== "--codex-home" || !codexHome || !isAbsolute(codexHome)
      || origin !== `chrome-extension://${allowedId}/` || extra.some(arg => !/^--parent-window=\d+$/.test(arg))) {
    process.exitCode = 1;
    return;
  }
  const active = new AbortController();
  const cancel = () => active.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  process.stdin.once("end", cancel);
  process.stdin.once("close", cancel);
  process.stdout.on("error", cancel);
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  let queued = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME * 2) { cancel(); process.stdin.destroy(); return; }
    while (buffer.length >= 4) {
      const length = LITTLE_ENDIAN ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (!length || length > MAX_FRAME) { cancel(); process.stdin.destroy(); return; }
      if (buffer.length < length + 4) break;
      const frame = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      if (++queued > 16) { cancel(); process.stdin.destroy(); return; }
      chain = chain.then(async () => {
        let id = "invalid";
        const timeout = setTimeout(cancel, TIMEOUT_MS);
        try {
          active.signal.throwIfAborted();
          const request = validateRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown);
          id = request.id;
          send({ id, ok: true, ...await runCodex(codexPath, codexHome, active.signal, request) });
        } catch (error) {
          const safe = error instanceof Error && /^(Codex |Cannot start Codex|Invalid |Unexpected |Choose a model|Grouping preferences |Grouping targets |Tab URLs|The group catalog |The model did not return |The assignments |Each new group needs )/.test(error.message)
            ? error.message : "Invalid connector request or cancelled operation.";
          send({ id, ok: false, error: safe });
        } finally { clearTimeout(timeout); queued--; }
      }).catch(() => { cancel(); process.stdin.destroy(); });
    }
  });
}

void main().catch(() => { process.exitCode = 1; });
