// What the release workflow does in an author's repository, as functions: read the tag, find the Plugin folder it
// names, pack it, merge the platforms' entries into one version with its Release URLs, and write the version into a
// `fyflow-plugins` checkout's `plugins/<id>.json`.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { lastLines, loadDefinition, LoadFailed } from "../lib/load.ts";
import { RUNNERS } from "../lib/repository.ts";
import {
  issuesOf,
  type Names,
  type PluginFile,
  PluginFileSchema,
  type PluginFileVersion,
} from "../lib/schema.ts";

/** A release the workflow will not make, and why. */
export class ReleaseRefused extends Error {}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `<id>@<version>` (`fyflow-ext.image-tags@0.1.0`): the id may hold dots, and `@` too; the version is after the last. */
export function parseTag(tag: string): { id: string; version: string } {
  const ref = tag.replace(/^refs\/tags\//, "");
  const at = ref.lastIndexOf("@");
  const id = ref.slice(0, Math.max(at, 0));
  const version = ref.slice(at + 1);
  if (at <= 0 || !VERSION.test(version))
    throw new ReleaseRefused(`the tag "${ref}" is not <id>@<version> (fyflow-ext.image-tags@0.1.0)`);
  return { id, version };
}

/**
 * What a Plugin's package.json may tell the workflow, under `"fyflow"`: its name and icon in the index, and, for a
 * Plugin built before it is packed, the command that builds it and the folder that is packed (which holds its own
 * package.json, the one npm packs).
 */
export interface FyflowConfig {
  name?: string;
  icon?: string;
  build?: string;
  pack?: string;
}

/** The Plugin's fields in the index, from its package.json. */
export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  icon?: string;
}

type Manifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  homepage?: unknown;
  repository?: unknown;
  fyflow?: FyflowConfig;
};

const readManifest = (dir: string): Manifest | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

/**
 * The folders that may be Plugins: each of `plugins/*` with a package.json, and the repository root unless it is a
 * monorepo's workspace (it has `plugins/*`, no `fyflow-plugin-sdk` peer and no `fyflow.pack`).
 */
export function pluginFolders(root: string): string[] {
  const folders: string[] = [];
  const plugins = join(root, "plugins");
  if (existsSync(plugins))
    for (const name of readdirSync(plugins, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
      if (existsSync(join(plugins, name, "package.json"))) folders.push(join(plugins, name));
  const manifest = readManifest(root) as (Manifest & { peerDependencies?: Record<string, unknown> }) | null;
  const rootIsPlugin =
    manifest !== null &&
    (folders.length === 0 ||
      manifest.peerDependencies?.["fyflow-plugin-sdk"] !== undefined ||
      manifest.fyflow?.pack !== undefined);
  return rootIsPlugin ? [root, ...folders] : folders;
}

/** A path relative to the repository, with forward slashes: `.` for the root. */
const shown = (root: string, path: string) => relative(root, path).split(sep).join("/") || ".";

/** `https://github.com/a/b` from a package.json's `repository`, when it is a GitHub one. */
function repositoryUrl(repository: unknown): string | undefined {
  const url = typeof repository === "string" ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return undefined;
  const match = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/.exec(url) ?? /^github:([^/]+\/[^/#]+)$/.exec(url);
  return match ? `https://github.com/${match[1]}` : undefined;
}

export function metaOf(id: string, manifest: Manifest): PluginMeta {
  const homepage =
    typeof manifest.homepage === "string" && manifest.homepage.startsWith("https://")
      ? manifest.homepage
      : repositoryUrl(manifest.repository);
  return {
    id,
    name: manifest.fyflow?.name ?? (typeof manifest.name === "string" ? manifest.name : id),
    description: typeof manifest.description === "string" ? manifest.description : "",
    ...(homepage !== undefined && { homepage }),
    ...(manifest.fyflow?.icon !== undefined && { icon: manifest.fyflow.icon }),
  };
}

/** Runs a command line through the shell in `cwd`, refusing the release when it fails. */
export function shell(command: string, cwd: string, what: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(stdout)
        : fail(new ReleaseRefused(`${what} failed (${command}, exit ${code}):\n${lastLines({ stdout, stderr })}`)),
    );
  });
}

/** The Plugin a tag names: where it is, the folder packed, its index fields and the names it declares. */
export interface FoundPlugin {
  /** Its folder, relative to the repository root (`.` or `plugins/x`). */
  dir: string;
  /** The folder packed: `dir`, or its `fyflow.pack` once built. */
  packDir: string;
  meta: PluginMeta;
  names: Names;
}

/**
 * Finds the Plugin folder whose definition has `id` and `version`: the root, or one of `plugins/*`. A folder whose
 * package.json has another version is passed over without running anything; the others are built (their
 * `fyflow.build`) and loaded, those whose entry's source names the id first.
 */
export async function findPlugin(root: string, id: string, version: string): Promise<FoundPlugin> {
  const folders = pluginFolders(root).filter((dir) => readManifest(dir)?.version === version);
  if (folders.length === 0)
    throw new ReleaseRefused(
      `no Plugin folder (the root, or plugins/*) has a package.json with version ${version}: set it, and the definition's version, to the tag's`,
    );
  const mentions = (dir: string) =>
    ["plugin.ts", "plugin.js", "src/plugin.ts"].some((f) => {
      try {
        return readFileSync(join(dir, f), "utf8").includes(id);
      } catch {
        return false;
      }
    });
  folders.sort((a, b) => Number(mentions(b)) - Number(mentions(a)));
  const tried: string[] = [];
  for (const dir of folders) {
    const manifest = readManifest(dir) as Manifest;
    const config = manifest.fyflow ?? {};
    if (config.build !== undefined) await shell(config.build, dir, `building ${shown(root, dir)}`);
    const packDir = resolve(dir, config.pack ?? ".");
    if (!existsSync(join(packDir, "package.json")))
      throw new ReleaseRefused(
        `${shown(root, packDir)} has no package.json: the folder fyflow.pack names is what npm packs, so it needs one`,
      );
    let loaded;
    try {
      loaded = await loadDefinition(packDir);
    } catch (error) {
      if (!(error instanceof LoadFailed)) throw error;
      tried.push(`${shown(root, packDir)}: ${error.message}`);
      continue;
    }
    if (loaded.id === id && loaded.version === version)
      return {
        dir: shown(root, dir),
        packDir: shown(root, packDir),
        meta: metaOf(id, manifest),
        names: { nodeTypes: loaded.nodeTypes, gateTypes: loaded.gateTypes },
      };
    tried.push(`${shown(root, packDir)}: ${String(loaded.id)} ${String(loaded.version)}`);
  }
  throw new ReleaseRefused(`no Plugin here is ${id} ${version}. Looked at:\n${tried.join("\n")}`);
}

/** The entry `fyflow-plugin pack` prints: one version, with `url` empty. */
export type PackEntry = Omit<PluginFileVersion, "names"> & { id: string };

/** What one pack job made: its Plugin, its tarball's file name, and its entry. */
export interface PackResult {
  tag: string;
  found: FoundPlugin;
  tarball: string;
  entry: PackEntry;
}

/** The command that runs `fyflow-plugin pack`: `FYFLOW_PLUGIN_PACK`, else npx with `FYFLOW_PLUGIN_SDK`. */
export const packCommand = () =>
  process.env.FYFLOW_PLUGIN_PACK ||
  `npx --yes -p "${process.env.FYFLOW_PLUGIN_SDK || "fyflow-plugin-sdk@^0.10.0"}" fyflow-plugin pack`; // quoted: cmd.exe reads ^ as an escape

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** Packs a Plugin folder into `out` with `fyflow-plugin pack`, for `platforms` when given; its tarball and entry. */
export async function packPlugin(
  packDir: string,
  out: string,
  platforms: readonly string[] = [],
): Promise<{ tarball: string; entry: PackEntry }> {
  await mkdir(out, { recursive: true });
  const before = new Set(readdirSync(out));
  const stdout = await shell(
    `${packCommand()} ${quote(packDir)} --out ${quote(out)}${platforms.map((p) => ` --platform ${quote(p)}`).join("")}`,
    packDir,
    "fyflow-plugin pack",
  );
  const start = stdout.indexOf("{");
  if (start === -1) throw new ReleaseRefused(`fyflow-plugin pack printed no entry:\n${stdout}`);
  const entry = JSON.parse(stdout.slice(start)) as PackEntry;
  const made = readdirSync(out).filter((f) => f.endsWith(".tgz") && !before.has(f));
  if (made.length !== 1) throw new ReleaseRefused(`fyflow-plugin pack wrote ${made.length} tarballs to ${out}, not one`);
  return { tarball: join(out, made[0] as string), entry };
}

/**
 * The pack jobs for the `platforms` input: one job for every platform when it is empty, else one per group (groups
 * separated by spaces or new lines, a group's platforms by commas: `win32-x64 darwin-arm64,darwin-x64`), each on the
 * runner of its first platform.
 */
export function packPlan(platforms: string): { platforms: string; runner: string }[] {
  const groups = platforms.split(/\s+/).filter(Boolean);
  if (groups.length === 0) return [{ platforms: "", runner: "ubuntu-latest" }];
  return groups.map((group) => {
    const names = group.split(",").filter(Boolean);
    for (const name of names)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw new ReleaseRefused(`the platform "${name}" is not <os> or <os>-<cpu>, as Node spells them (linux-x64)`);
    // One os per group (darwin-arm64,darwin-x64 is a universal macOS build), packed on its first platform's runner.
    const systems = new Set(names.map((name) => name.split("-")[0]));
    const runner = RUNNERS[names[0] as string];
    if (runner === undefined || systems.size !== 1)
      throw new ReleaseRefused(
        `the platforms "${group}" are not packed on one GitHub runner: group platforms of one os, the first one of ${Object.keys(RUNNERS).join(", ")}`,
      );
    return { platforms: names.join(","), runner };
  });
}

/** A Release asset's download URL: `https://github.com/<repo>/releases/download/<tag>/<file>`, each part encoded. */
export const assetUrl = (repo: string, tag: string, file: string) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;

/**
 * One version from the pack jobs' results: one tarball's entry with its URL, or every platform's artifacts merged
 * into `artifacts`. They must agree on the Plugin, its version, SDK range, Python, fields and names.
 */
export function mergeResults(
  results: readonly PackResult[],
  repo: string,
): { meta: PluginMeta; version: PluginFileVersion; assets: string[] } {
  const [first, ...rest] = results;
  if (first === undefined) throw new ReleaseRefused("no pack results to release");
  const same = (what: string, of: (r: PackResult) => unknown) => {
    for (const r of rest)
      if (JSON.stringify(of(r)) !== JSON.stringify(of(first)))
        throw new ReleaseRefused(
          `the platforms' packs disagree on ${what}: ${JSON.stringify(of(first))} (${first.tarball}) and ${JSON.stringify(of(r))} (${r.tarball})`,
        );
  };
  same("the tag", (r) => r.tag);
  same("the id", (r) => r.entry.id);
  same("the version", (r) => r.entry.version);
  same("the sdk range", (r) => r.entry.sdk);
  same("python", (r) => r.entry.python);
  same("the Plugin's fields", (r) => r.found.meta);
  same("the Node Types and gate types", (r) => ({
    nodeTypes: [...r.found.names.nodeTypes].sort(),
    gateTypes: [...r.found.names.gateTypes].sort(),
  }));
  const { id: _, url: __, integrity: ___, platforms: ____, artifacts: _____, ...fields } = first.entry;
  const tag = first.tag;
  let version: PluginFileVersion;
  if (results.every((r) => r.entry.artifacts === undefined)) {
    if (results.length > 1) throw new ReleaseRefused("several tarballs packed without --platform: one version has one");
    const { entry } = first;
    version = {
      ...fields,
      url: assetUrl(repo, tag, first.tarball),
      integrity: entry.integrity as string,
      ...(entry.platforms !== undefined && { platforms: entry.platforms }),
      names: first.found.names,
    };
  } else if (results.every((r) => r.entry.artifacts !== undefined)) {
    version = {
      ...fields,
      artifacts: results.flatMap((r) =>
        (r.entry.artifacts ?? []).map((a) => ({ ...a, url: assetUrl(repo, tag, r.tarball) })),
      ),
      names: first.found.names,
    };
  } else throw new ReleaseRefused("some tarballs were packed with --platform and some without: pack all one way");
  return { meta: first.found.meta, version, assets: results.map((r) => r.tarball) };
}

/**
 * The Plugin's file with the new version added (a new file for its first version), its fields from `meta`. Refuses
 * a version the file already has, and a result that does not match the repository's schema.
 */
export function withVersion(existing: PluginFile | null, meta: PluginMeta, version: PluginFileVersion): PluginFile {
  if (existing !== null && existing.id !== meta.id)
    throw new ReleaseRefused(`the file is ${existing.id}'s, not ${meta.id}'s`);
  if (existing?.versions.some((v) => v.version === version.version))
    throw new ReleaseRefused(`${meta.id} ${version.version} is in the repository already: a version is published once`);
  const { id, name, description, homepage, icon } = meta;
  const file = {
    id,
    name,
    description,
    ...(homepage !== undefined && { homepage }),
    ...(icon !== undefined && { icon }),
    versions: [...(existing?.versions ?? []), version],
  };
  const checked = PluginFileSchema.safeParse(file);
  if (!checked.success)
    throw new ReleaseRefused(`the entry does not match the repository's schema:\n${issuesOf(checked.error).join("\n")}`);
  return checked.data;
}

export { basename };
