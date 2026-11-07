import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST_NAME } from "../src/shared";

const USAGE = `Install Tabmap's user-level Codex connector (Node.js 22+).

node install.js --extension-id ID --browser chrome|chromium|edge
  [--user-data-dir PATH] [--codex-path PATH] [--login]

Install Codex first. Use --login for the connector's separate one-time login.
Copy the extension ID from your browser's extensions page. Keep this directory and Node installed.
On Windows --codex-path must identify codex.exe, not a .cmd wrapper.
Windows registration uses HKCU and is per browser, not per user-data-dir.
Requires a Codex app-server with named permission profiles and empty-environment
support (protocol inspected against Codex 0.166.0).
`;

type Browser = "chrome" | "chromium" | "edge";

async function executablePath(explicit: string | undefined): Promise<string> {
  const candidates = explicit ? [resolve(explicit)] : (process.env.PATH ?? "").split(delimiter)
    .filter(Boolean).map(directory => join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
  for (const candidate of candidates) {
    try {
      const absolute = await realpath(candidate);
      await access(absolute, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (process.platform === "win32" && !absolute.toLowerCase().endsWith(".exe")) continue;
      return absolute;
    } catch { /* Continue searching PATH; never expose filesystem error details. */ }
  }
  throw new Error("Cannot find the Codex executable. Install Codex or supply --codex-path (codex.exe on Windows).");
}

function profileDirectory(browser: Browser): string {
  if (process.platform === "darwin") {
    const names = { chrome: "Google/Chrome", chromium: "Chromium", edge: "Microsoft Edge" };
    return join(homedir(), "Library", "Application Support", names[browser]);
  }
  if (process.platform === "linux") {
    const config = process.env.CHROME_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const names = { chrome: "google-chrome", chromium: "chromium", edge: "microsoft-edge" };
    return resolve(config, names[browser]);
  }
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw new Error("LOCALAPPDATA is unavailable. Supply --user-data-dir for connector files.");
  const names = { chrome: "Google/Chrome/User Data", chromium: "Chromium/User Data", edge: "Microsoft/Edge/User Data" };
  return join(local, names[browser]);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteBatch(value: string): string {
  // Batch expansion is unsafe for these characters even inside double quotes.
  // Reject unusual installation paths rather than execute a different command.
  if (/["%\r\n!]/.test(value)) throw new Error("Windows connector paths cannot contain quotes, %, !, or line breaks. Move the connector to a plain path.");
  return `"${value}"`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(USAGE); return; }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Install Node.js 22 or newer before running the installer.");
  if (!["linux", "darwin", "win32"].includes(process.platform)) throw new Error("This installer supports Linux, macOS, and Windows only.");
  let values: { "extension-id"?: string; browser?: string; "user-data-dir"?: string; "codex-path"?: string; login?: boolean };
  try {
    ({ values } = parseArgs({ options: {
      "extension-id": { type: "string" }, browser: { type: "string" },
      "user-data-dir": { type: "string" }, "codex-path": { type: "string" },
      login: { type: "boolean" },
    }, strict: true, allowPositionals: false }));
  } catch { throw new Error("Invalid arguments. Run node install.js --help for usage."); }
  const extensionId = values["extension-id"];
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) throw new Error("--extension-id must be the 32-letter ID shown on the browser's extensions page.");
  const browser = values.browser;
  if (browser !== "chrome" && browser !== "chromium" && browser !== "edge") throw new Error("Set --browser to chrome, chromium, or edge.");
  const node = await realpath(process.execPath);
  const script = await realpath(join(dirname(fileURLToPath(import.meta.url)), "connector.js"));
  const codex = await executablePath(values["codex-path"]);
  const profile = values["user-data-dir"] ? resolve(values["user-data-dir"]) : profileDirectory(browser);
  const hostDirectory = join(profile, "NativeMessagingHosts");
  const codexHome = join(hostDirectory, `${HOST_NAME}-home`);
  const launcher = join(hostDirectory, `${HOST_NAME}-${extensionId}${process.platform === "win32" ? ".cmd" : ".sh"}`);
  const manifest = join(hostDirectory, `${HOST_NAME}.json`);
  const args = [node, script, "--extension-id", extensionId, "--codex-path", codex, "--codex-home", codexHome];
  const launcherText = process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.map(quoteBatch).join(" ")} %*\r\n`
    : `#!/bin/sh\nexec ${args.map(quoteShell).join(" ")} "$@"\n`;
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(launcher, launcherText, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(launcher, 0o700);
  await writeFile(manifest, `${JSON.stringify({
    name: HOST_NAME, description: "Tabmap Codex connector", path: launcher,
    type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform === "win32") {
    const registryNames = { chrome: "Google\\Chrome", chromium: "Chromium", edge: "Microsoft\\Edge" };
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable; native host files were written but registration failed.");
    try {
      execFileSync(join(systemRoot, "System32", "reg.exe"), ["ADD", `HKCU\\Software\\${registryNames[browser]}\\NativeMessagingHosts\\${HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore", windowsHide: true });
    } catch { throw new Error("Native host files were written, but HKCU registration failed. Check your user registry permissions and rerun the installer."); }
  }
  console.log(`Installed ${HOST_NAME} for ${browser}.\nManifest: ${manifest}\nLauncher: ${launcher}\nDedicated Codex home: ${codexHome}`);
  if (values.login) {
    try {
      execFileSync(codex, ["login"], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: "inherit", windowsHide: false });
    } catch { throw new Error("Connector installed, but login did not complete. Run this installer again with --login."); }
  } else {
    console.log("Run this installer again with --login to authenticate the dedicated Codex home, then load models in Tabmap.");
  }
}

void main().catch(error => {
  // Only messages authored here may reach the terminal. Node's filesystem and
  // process errors can contain sensitive paths or command output.
  const message = error instanceof Error && /^(Cannot find|LOCALAPPDATA|Windows connector|Install Node|This installer|Invalid arguments|--extension-id|Set --browser|Windows SystemRoot|Native host files)/.test(error.message)
    ? error.message : "Installation failed. Check that connector.js is beside install.js and that the chosen directory is writable.";
  console.error(message);
  process.exitCode = 1;
});
