// Checking one artifact of a new version: download it, verify its integrity, unpack it, check what it holds against
// its entry, then load it as a Host does and compare its definition with the entry.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Finding } from "./repository.ts";
import { installDependencies, installSdk, loadDefinition, LoadFailed } from "./load.ts";
import { artifactsOf, type PluginFile, type PluginFileVersion } from "./schema.ts";
import { BadArtifact, download, unpackTgz, verifyIntegrity } from "./tarball.ts";

const SDK = "fyflow-plugin-sdk";
/** What an author ships by mistake from a Python project. */
const NOT_SHIPPED = /(^|\/)(\.venv|__pycache__)(\/|$)/;

const hasAny = (deps: unknown) =>
  typeof deps === "object" && deps !== null && Object.keys(deps as object).length > 0;

const sameNames = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export interface ArtifactCheck {
  plugin: PluginFile;
  version: PluginFileVersion;
  /** Its place in the version's artifacts. */
  artifact: number;
  /** Whether to run its code (false where no runner has its platform). */
  load: boolean;
  /** A folder of its own to work in; the SDK is installed in `sdkRoot`, which must be above it. */
  work: string;
  sdkRoot: string;
  /** How the tarball is fetched: `download` unless a test says otherwise. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

/** Everything wrong with one artifact, as refusals, and what is only worth a warning. */
export async function checkArtifact(c: ArtifactCheck): Promise<{ problems: Finding[]; warnings: Finding[] }> {
  const { plugin, version } = c;
  const problems: Finding[] = [];
  const warnings: Finding[] = [];
  const at = artifactsOf(version)[c.artifact];
  const base = { file: `plugins/${plugin.id}.json`, plugin: plugin.id, version: version.version };
  const which = version.artifacts === undefined ? "its artifact" : `its artifact [${c.artifact}]`;
  const refuse = (rule: string, message: string) => problems.push({ ...base, rule, message: `${which}: ${message}` });
  const warn = (rule: string, message: string) => warnings.push({ ...base, rule, message: `${which}: ${message}` });
  if (at === undefined) {
    refuse("artifact", "is not there");
    return { problems, warnings };
  }

  // 1. The tarball, as a Host gets it.
  const dir = join(c.work, "plugin");
  let files: string[];
  try {
    const bytes = await (c.fetchBytes ?? download)(at.url);
    verifyIntegrity(bytes, at.integrity);
    await rm(c.work, { recursive: true, force: true });
    await mkdir(c.work, { recursive: true });
    files = await unpackTgz(bytes, dir);
  } catch (error) {
    if (!(error instanceof BadArtifact)) throw error;
    refuse("tarball", error.message);
    return { problems, warnings };
  }

  // 2. What it holds.
  let manifest: Record<string, unknown> & {
    version?: unknown;
    peerDependencies?: Record<string, unknown>;
    dependencies?: unknown;
    optionalDependencies?: unknown;
  };
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    refuse("package", "has no package/package.json that parses");
    return { problems, warnings };
  }
  if (manifest.version !== version.version)
    refuse("package", `its package.json says version ${String(manifest.version)}, the entry ${version.version}`);
  const peer = manifest.peerDependencies?.[SDK];
  if (peer !== version.sdk)
    refuse(
      "package",
      peer === undefined
        ? `its package.json has no ${SDK} peer range; the entry's sdk is "${version.sdk}"`
        : `its package.json's ${SDK} peer range is "${String(peer)}", the entry's sdk "${version.sdk}"`,
    );
  const bundled = files.some((f) => f.startsWith("node_modules/"));
  const needsInstall = (hasAny(manifest.dependencies) || hasAny(manifest.optionalDependencies)) && !bundled;
  if (needsInstall && !files.includes("npm-shrinkwrap.json"))
    refuse(
      "shrinkwrap",
      "its package has dependencies and no npm-shrinkwrap.json, which a Host installs them from (fyflow-plugin pack writes it)",
    );
  const shipped = files.find((f) => NOT_SHIPPED.test(f));
  if (shipped !== undefined)
    warn("python-files", `it holds ${shipped}: leave .venv and __pycache__ out (package.json's \`files\`)`);
  if (version.python !== false) {
    const folders = (name: string) =>
      new Set(files.filter((f) => f === name || f.endsWith(`/${name}`)).map((f) => f.slice(0, -name.length)));
    const pyproject = folders("pyproject.toml");
    if (![...folders("uv.lock")].some((f) => pyproject.has(f)))
      refuse("python", "the entry says it has Python Workers, and it holds no Python project with pyproject.toml and uv.lock");
  }
  if (problems.length > 0 || !c.load) return { problems, warnings };

  // 3. Its code, loaded as a Host loads it.
  if (!c.work.startsWith(c.sdkRoot)) throw new Error(`${c.work} is not under ${c.sdkRoot}, where the SDK is`);
  await installSdk(c.sdkRoot);
  let loaded;
  try {
    if (needsInstall) await installDependencies(dir);
    loaded = await loadDefinition(dir);
  } catch (error) {
    if (!(error instanceof LoadFailed)) throw error;
    refuse("load", error.message);
    return { problems, warnings };
  }
  if (loaded.id !== plugin.id) refuse("load", `its definition's id is ${JSON.stringify(loaded.id)}, not ${plugin.id}`);
  if (loaded.version !== version.version)
    refuse("load", `its definition's version is ${JSON.stringify(loaded.version)}, not ${version.version}`);
  for (const [kind, label] of [
    ["nodeTypes", "Node Types"],
    ["gateTypes", "gate types"],
  ] as const)
    if (!sameNames(loaded[kind], version.names[kind]))
      refuse(
        "names",
        `its definition declares the ${label} ${JSON.stringify(loaded[kind])}, and the entry's names.${kind} ${JSON.stringify(version.names[kind])}: make the entry's say what the definition does`,
      );
  if ((loaded.pythonWorkers.length > 0) !== (version.python !== false))
    refuse(
      "python",
      loaded.pythonWorkers.length > 0
        ? `its definition has Python Workers (${loaded.pythonWorkers.join(", ")}), and the entry's python is false`
        : "the entry's python is not false, and its definition has no Python Workers",
    );
  if (loaded.pythonWorkers.length > 0) {
    const project = loaded.pythonProject;
    if (project === null) refuse("python", "its definition has Python Workers and no `python.project`");
    else
      for (const file of ["pyproject.toml", "uv.lock"])
        if (!existsSync(join(project, file)))
          refuse(
            "python",
            `its Python project (${relative(dir, project).split(sep).join("/") || "."}) has no ${file} in the tarball`,
          );
  }
  return { problems, warnings };
}
