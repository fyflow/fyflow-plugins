// The checks on `plugins/*.json` that need no download: each file parses and matches the schema, is named for its
// id, ids are unique, Node Type and gate type names are unique across Plugins, and (against the PR's base) no
// published version changed or went away. Also the plan of which artifacts the PR's new versions bring, and on which
// runner each is loaded.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { satisfiesRange } from "./sdk-range.ts";
import {
  artifactsOf,
  HOST_SDK_VERSIONS,
  ICON_NAMES,
  issuesOf,
  type PluginFile,
  PluginFileSchema,
  type PluginFileVersion,
} from "./schema.ts";

/** A refusal or a warning, naming where it is and which rule it comes from. */
export interface Finding {
  /** The file, relative to the repository: `plugins/acme.tagger.json`. */
  file: string;
  plugin?: string;
  version?: string;
  /** A short name for the rule: `schema`, `file-name`, `immutable`, `names`, `integrity`… */
  rule: string;
  message: string;
}

/** `plugins/acme.tagger.json: acme.tagger 1.0.0 [immutable]: …` */
export const formatFinding = (f: Finding) =>
  `${f.file}: ${[f.plugin, f.version].filter(Boolean).join(" ")}${f.plugin ? " " : ""}[${f.rule}] ${f.message}`;

/** A file under `plugins/`, as text. */
export interface SourceFile {
  file: string;
  text: string;
}

/** A Plugin file that parsed and matched the schema. */
export interface CheckedPlugin {
  file: string;
  plugin: PluginFile;
}

export const PLUGINS_DIR = "plugins";
export const fileOf = (id: string) => `${PLUGINS_DIR}/${id}.json`;

/** `plugins/*.json`, sorted; none when the folder is not there. Other files in it (`.gitkeep`) are not Plugins. */
export async function readPluginFiles(root: string): Promise<SourceFile[]> {
  let names: string[];
  try {
    names = await readdir(join(root, PLUGINS_DIR));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const files: SourceFile[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort())
    files.push({ file: `${PLUGINS_DIR}/${name}`, text: await readFile(join(root, PLUGINS_DIR, name), "utf8") });
  return files;
}

/** Each file parsed and checked against the schema and its name; what failed, as refusals. */
export function parsePluginFiles(files: readonly SourceFile[]): { plugins: CheckedPlugin[]; problems: Finding[] } {
  const plugins: CheckedPlugin[] = [];
  const problems: Finding[] = [];
  for (const { file, text } of files) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      problems.push({ file, rule: "json", message: `is not JSON: ${(error as Error).message}` });
      continue;
    }
    const parsed = PluginFileSchema.safeParse(data);
    const id = typeof (data as { id?: unknown })?.id === "string" ? (data as { id: string }).id : undefined;
    if (!parsed.success) {
      for (const message of issuesOf(parsed.error)) problems.push({ file, plugin: id, rule: "schema", message });
      continue;
    }
    if (file !== fileOf(parsed.data.id)) {
      problems.push({
        file,
        plugin: parsed.data.id,
        rule: "file-name",
        message: `a Plugin's file is named for its id: rename it to ${fileOf(parsed.data.id)}`,
      });
      continue;
    }
    plugins.push({ file, plugin: parsed.data });
  }
  // File names are unique, so ids are too, except on a case-insensitive file system, where two would be one file.
  const seen = new Map<string, string>();
  for (const { file, plugin } of plugins) {
    const other = seen.get(plugin.id.toLowerCase());
    if (other !== undefined)
      problems.push({
        file,
        plugin: plugin.id,
        rule: "unique-id",
        message: `its id differs from ${other}'s only in case: ids are unique, whatever their case`,
      });
    seen.set(plugin.id.toLowerCase(), plugin.id);
  }
  return { plugins, problems };
}

/**
 * Node Type and gate type names another Plugin already declares, in any of its versions (fyflow-app ADR-0029: a
 * name is global on a Host). `established` are the ids that had the name first (the PR's base): a clash is reported
 * on the other Plugin. A Plugin may keep its own names from version to version.
 */
export function nameClashes(plugins: readonly CheckedPlugin[], established: ReadonlySet<string> = new Set()): Finding[] {
  const problems: Finding[] = [];
  const ordered = [...plugins].sort(
    (a, b) =>
      Number(!established.has(a.plugin.id)) - Number(!established.has(b.plugin.id)) ||
      a.plugin.id.localeCompare(b.plugin.id),
  );
  for (const [kind, label] of [
    ["nodeTypes", "Node Type"],
    ["gateTypes", "gate type"],
  ] as const) {
    const owner = new Map<string, string>();
    for (const { file, plugin } of ordered) {
      const reported = new Set<string>();
      for (const version of plugin.versions)
        for (const name of version.names[kind]) {
          const first = owner.get(name);
          if (first === undefined) owner.set(name, plugin.id);
          else if (first !== plugin.id && !reported.has(name)) {
            reported.add(name);
            problems.push({
              file,
              plugin: plugin.id,
              version: version.version,
              rule: "names",
              message: `its ${label} "${name}" is already ${first}'s: ${label} names are global on a Host, so rename it`,
            });
          }
        }
    }
  }
  return problems;
}

/** A Plugin's versions by version. */
const versionsOf = (plugin: { versions: { version: string }[] }) =>
  new Map(plugin.versions.map((v) => [v.version, v]));

/** JSON with sorted keys, to compare two versions whatever order their keys were written in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** A version of a Plugin that the PR adds. */
export interface AddedVersion {
  id: string;
  version: string;
}

/**
 * What the PR changes against its base: the versions it adds, and refusals for every published version it edits or
 * removes. Removing one is a maintainer's decision, which `allowRemoval` (the PR's `remove-version` label) admits;
 * editing one never is, as Hosts have installed it by its integrity.
 */
export function compareWithBase(
  base: readonly SourceFile[],
  head: readonly CheckedPlugin[],
  { allowRemoval = false } = {},
): { added: AddedVersion[]; problems: Finding[]; changed: Set<string> } {
  const problems: Finding[] = [];
  const added: AddedVersion[] = [];
  const changed = new Set<string>();
  const headByFile = new Map(head.map((p) => [p.file, p.plugin]));
  const baseFiles = new Set(base.map((b) => b.file));
  for (const { file, text } of base) {
    let before: { id: string; versions: { version: string }[] } & Record<string, unknown>;
    try {
      before = JSON.parse(text);
    } catch {
      continue; // the base was refused already; nothing of it was published
    }
    const after = headByFile.get(file);
    if (after === undefined) {
      changed.add(before.id);
      if (!allowRemoval)
        problems.push({
          file,
          plugin: before.id,
          rule: "immutable",
          message: "removes a published Plugin: only a maintainer removes one (README, Removing a version)",
        });
      continue;
    }
    const now = versionsOf(after);
    if (canonical({ ...before, versions: [] }) !== canonical({ ...after, versions: [] })) changed.add(after.id);
    for (const [version, was] of versionsOf(before)) {
      const is = now.get(version);
      if (is === undefined) {
        changed.add(after.id);
        if (!allowRemoval)
          problems.push({
            file,
            plugin: after.id,
            version,
            rule: "immutable",
            message: "removes a published version: only a maintainer removes one (README, Removing a version)",
          });
      } else if (canonical(was) !== canonical(is)) {
        changed.add(after.id);
        const keys = [...new Set([...Object.keys(was), ...Object.keys(is)])].filter(
          (k) => canonical((was as Record<string, unknown>)[k]) !== canonical((is as Record<string, unknown>)[k]),
        );
        problems.push({
          file,
          plugin: after.id,
          version,
          rule: "immutable",
          message: `changes a published version (${keys.join(", ")}): a version never changes once published; release a new one`,
        });
      }
    }
    for (const version of now.keys())
      if (!versionsOf(before).has(version)) {
        changed.add(after.id);
        added.push({ id: after.id, version });
      }
  }
  for (const { file, plugin } of head)
    if (!baseFiles.has(file)) {
      changed.add(plugin.id);
      for (const { version } of plugin.versions) added.push({ id: plugin.id, version });
    }
  return { added, problems, changed };
}

/** Warnings, not refusals: an icon the app does not have, an `sdk` range no current Host admits. */
export function warningsFor(plugin: CheckedPlugin, versions?: ReadonlySet<string>): Finding[] {
  const warnings: Finding[] = [];
  const { file, plugin: p } = plugin;
  if (p.icon !== undefined && !ICON_NAMES.includes(p.icon))
    warnings.push({
      file,
      plugin: p.id,
      rule: "icon",
      message: `its icon "${p.icon}" is not one of the app's, so it is not shown (see the README for the list)`,
    });
  for (const v of p.versions) {
    if (versions !== undefined && !versions.has(v.version)) continue;
    const admits = HOST_SDK_VERSIONS.map((sdk) => satisfiesRange(sdk, v.sdk));
    if (admits.includes(null))
      warnings.push({
        file,
        plugin: p.id,
        version: v.version,
        rule: "sdk",
        message: `its sdk range "${v.sdk}" cannot be read by a Host (use ^, ~, comparisons, x and ||), so no Host lists it`,
      });
    else if (!admits.includes(true))
      warnings.push({
        file,
        plugin: p.id,
        version: v.version,
        rule: "sdk",
        message: `its sdk range "${v.sdk}" admits none of ${HOST_SDK_VERSIONS.join(", ")}, so no current Host lists it`,
      });
  }
  return warnings;
}

/** The GitHub-hosted runner a platform's artifact is loaded on; null for a platform none runs. */
export const RUNNERS: Record<string, string> = {
  linux: "ubuntu-latest",
  "linux-x64": "ubuntu-latest",
  "linux-arm64": "ubuntu-24.04-arm",
  darwin: "macos-latest",
  "darwin-arm64": "macos-latest",
  "darwin-x64": "macos-15-intel",
  win32: "windows-latest",
  "win32-x64": "windows-latest",
  "win32-arm64": "windows-11-arm",
};

/** One artifact to download, check and load, on one runner: a job of the PR check's matrix. */
export interface LoadJob {
  id: string;
  version: string;
  /** Its place in the version's artifacts (0 for a version with one `url`). */
  artifact: number;
  /** What the job is called: the platforms it stands for. */
  platforms: string;
  runner: string;
  /** False when no runner has its platforms: the tarball is checked, and its code not run. */
  load: boolean;
}

/**
 * The load jobs for the added versions: each artifact on a runner of each platform it names (an artifact for every
 * platform on Linux). An artifact for platforms no runner has is still downloaded and checked, on Linux, unloaded.
 */
export function loadPlan(head: readonly CheckedPlugin[], added: readonly AddedVersion[]): {
  jobs: LoadJob[];
  warnings: Finding[];
} {
  const jobs: LoadJob[] = [];
  const warnings: Finding[] = [];
  for (const { id, version } of added) {
    const found = head.find((p) => p.plugin.id === id);
    const v = found?.plugin.versions.find((x) => x.version === version);
    if (found === undefined || v === undefined) continue;
    artifactsOf(v).forEach((artifact, at) => {
      if (artifact.platforms === null) {
        jobs.push({ id, version, artifact: at, platforms: "any", runner: "ubuntu-latest", load: true });
        return;
      }
      const runners = new Map<string, string[]>();
      for (const platform of artifact.platforms) {
        const runner = RUNNERS[platform];
        if (runner === undefined)
          warnings.push({
            file: found.file,
            plugin: id,
            version,
            rule: "platform",
            message: `no CI runner has the platform ${platform}: its artifact is not loaded there`,
          });
        else runners.set(runner, [...(runners.get(runner) ?? []), platform]);
      }
      if (runners.size === 0)
        jobs.push({
          id,
          version,
          artifact: at,
          platforms: artifact.platforms.join(","),
          runner: "ubuntu-latest",
          load: false,
        });
      for (const [runner, platforms] of runners)
        jobs.push({ id, version, artifact: at, platforms: platforms.join(","), runner, load: true });
    });
  }
  return { jobs, warnings };
}

export type { PluginFileVersion };
