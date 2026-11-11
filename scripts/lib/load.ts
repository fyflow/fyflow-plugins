// Loading a Plugin the way a Host does, to read its definition: the SDK installed in a folder above the Plugin (the
// Host provides it the same way), the Plugin's npm dependencies installed from its shrinkwrap with install scripts
// off, then its entry imported in a Node process of its own, which prints what the definition declares.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** What a loaded definition declares, as the child process reports it. */
export interface Loaded {
  /** The module it imported: `plugin.ts`, `plugin.js`, or the package's entry. */
  entry: string;
  id: unknown;
  version: unknown;
  nodeTypes: string[];
  gateTypes: string[];
  /** Its Python Workers' keys. */
  pythonWorkers: string[];
  /** Its Python project's folder, as a path; null without a `python` section. */
  pythonProject: string | null;
}

/** A Plugin that would not load, and why. */
export class LoadFailed extends Error {}

/** What the SDK is installed from: an npm spec, or a tarball's path (`FYFLOW_PLUGIN_SDK`). */
export const sdkSpec = () => process.env.FYFLOW_PLUGIN_SDK || "fyflow-plugin-sdk@^0.10.0";

/** The environment a stranger's code and npm get: enough to run, and no token or secret of the job's. */
export function plainEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "ComSpec",
    "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "npm_config_cache", "NPM_CONFIG_CACHE", "npm_config_registry",
  ];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

/** Runs a program, collecting its output; `timeout` kills it. */
export function run(
  command: string,
  args: readonly string[],
  { cwd, env = plainEnv(), timeout = 10 * 60_000 }: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    // npm is a .cmd on Windows, which only a shell runs; the arguments here are ours, never an entry's.
    const shell = process.platform === "win32" && command === "npm";
    const child = spawn(shell ? `npm ${args.map((a) => `"${a}"`).join(" ")}` : command, shell ? [] : args, {
      cwd,
      env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n(killed after ${timeout / 1000} s)`;
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** A failed run's last lines, to quote in a refusal. */
export const lastLines = (r: { stdout: string; stderr: string }, n = 15) =>
  `${r.stdout}\n${r.stderr}`
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/^\s+at /.test(line)) // stack frames: the error itself is what tells
    .slice(-n)
    .join("\n");

/**
 * Installs the SDK in `root/node_modules/fyflow-plugin-sdk`, once: a Plugin unpacked anywhere under `root` imports
 * it from there, as from the Host's.
 */
export async function installSdk(root: string, spec = sdkSpec()): Promise<string> {
  const installed = join(root, "node_modules", "fyflow-plugin-sdk", "package.json");
  const marker = join(root, ".sdk-spec");
  if (existsSync(installed) && existsSync(marker) && readFileSync(marker, "utf8") === spec) return root;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), '{ "private": true }\n');
  const r = await run(
    "npm",
    ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=peer", spec],
    { cwd: root },
  );
  if (r.code !== 0 || !existsSync(installed))
    throw new Error(`could not install the SDK (${spec}) for loading Plugins:\n${lastLines(r)}`);
  await writeFile(marker, spec);
  return root;
}

/** The SDK's version installed under `root`. */
export const installedSdkVersion = (root: string): string =>
  JSON.parse(readFileSync(join(root, "node_modules", "fyflow-plugin-sdk", "package.json"), "utf8")).version;

/**
 * Installs a Plugin's npm dependencies as a Host does: `npm ci` from its `npm-shrinkwrap.json`, scripts, dev
 * dependencies and peers left out; then removes a copy of the SDK, which is always the Host's.
 */
export async function installDependencies(dir: string): Promise<void> {
  const r = await run(
    "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", "--no-update-notifier"],
    { cwd: dir },
  );
  if (r.code !== 0) throw new LoadFailed(`npm ci failed, as it would on a Host:\n${lastLines(r)}`);
  await rm(join(dir, "node_modules", "fyflow-plugin-sdk"), { recursive: true, force: true });
}

const CHILD = fileURLToPath(new URL("./load-child.ts", import.meta.url));
export const MARKER = "@@fyflow-plugin-definition@@";

/** Imports the Plugin in `dir` in a Node process of its own and reports what its definition declares. */
export async function loadDefinition(dir: string, { timeout = 120_000 } = {}): Promise<Loaded> {
  const r = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CHILD, dir], {
    cwd: dir,
    timeout,
  });
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (r.code !== 0 || line === undefined) throw new LoadFailed(`its code failed to load:\n${lastLines(r)}`);
  return JSON.parse(line.slice(MARKER.length)) as Loaded;
}
