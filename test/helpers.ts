// What the tests share: the SDK installed once under `.work/test` (from FYFLOW_PLUGIN_SDK: an npm spec, or the path
// of a tarball `pnpm sdk:pack` made), the fixture Plugins copied there and packed with its `fyflow-plugin pack`, and
// tarballs made by hand for what `pack` would refuse to make.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { installSdk, run } from "../scripts/lib/load.ts";
import type { Names, PluginFile, PluginFileVersion } from "../scripts/lib/schema.ts";
import { integrityOf } from "../scripts/lib/tarball.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "test", "fixtures");
/** Where the SDK is installed: everything unpacked or copied under it imports `fyflow-plugin-sdk` from there. */
export const WORK = join(ROOT, ".work", "test");

let ready: Promise<string> | undefined;
/** Installs the SDK under WORK once; the path of its `fyflow-plugin` bin. */
export function sdk(): Promise<string> {
  ready ??= installSdk(WORK).then(() => join(WORK, "node_modules", "fyflow-plugin-sdk", "dist", "cli.js"));
  return ready;
}

/** `node <cli.js> pack`, the command the release scripts run in tests (FYFLOW_PLUGIN_PACK). */
export async function packCommandForTests(): Promise<string> {
  return `"${process.execPath}" "${await sdk()}" pack`;
}

let copies = 0;
/** A fresh copy of a fixture under WORK, where the SDK resolves; `change` edits it before use. */
export function copyFixture(path: string, change?: (dir: string) => void): string {
  const dir = join(WORK, "copies", `${path.replace(/[\\/]/g, "-")}-${process.pid}-${copies++}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(FIXTURES, path), dir, { recursive: true });
  change?.(dir);
  return dir;
}

export interface Packed {
  bytes: Uint8Array;
  tarball: string;
  /** The entry `fyflow-plugin pack` printed. */
  entry: Record<string, unknown> & { id: string; version: string; integrity?: string };
}

/** Packs a fixture Plugin (`plugins/<name>`) with the SDK's `fyflow-plugin pack`. */
export async function packFixture(
  name: string,
  { platforms = [], change }: { platforms?: string[]; change?: (dir: string) => void } = {},
): Promise<Packed> {
  const cli = await sdk();
  const dir = copyFixture(join("plugins", name), change);
  // An author packs with its dependencies installed: its code is loaded.
  if (existsSync(join(dir, "package-lock.json"))) {
    const ci = await run("npm", ["ci", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund"], { cwd: dir, env: process.env });
    if (ci.code !== 0) throw new Error(`npm ci in ${name} failed:
${ci.stdout}
${ci.stderr}`);
  }
  const out = join(dir, "..", `${dir.split(/[\\/]/).at(-1)}-out`);
  const r = await run(
    process.execPath,
    [cli, "pack", dir, "--out", out, ...platforms.flatMap((p) => ["--platform", p])],
    { cwd: dir, env: process.env },
  );
  if (r.code !== 0) throw new Error(`pack ${name} failed:\n${r.stdout}\n${r.stderr}`);
  const entry = JSON.parse(r.stdout);
  const file = readdirSync(out).find((f) => f.endsWith(".tgz")) as string;
  const tarball = join(out, file);
  return { bytes: readFileSync(tarball), tarball, entry };
}

/** A gzipped ustar archive of `files`, each under `package/`, as npm packs them. */
export function makeTgz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A URL for a test artifact, served by `fetchFrom`. */
export const urlOf = (name: string) => `https://example.test/${name}.tgz`;

/** A `fetchBytes` that serves tarballs by URL from memory. */
export const fetchFrom = (served: Record<string, Uint8Array>) => async (url: string) => {
  const bytes = served[url];
  if (bytes === undefined) throw new Error(`no test tarball at ${url}`);
  return bytes;
};

export const NO_NAMES: Names = { nodeTypes: [], gateTypes: [] };

/** A valid version for a Plugin file, with a made-up artifact. */
export function version(v: string, extra: Partial<PluginFileVersion> = {}): PluginFileVersion {
  return {
    version: v,
    sdk: "^0.10.0",
    python: false,
    url: urlOf(`x-${v}`),
    integrity: integrityOf(Buffer.from(v)),
    names: NO_NAMES,
    ...extra,
  } as PluginFileVersion;
}

/** A valid Plugin file. */
export function pluginFile(id: string, versions: PluginFileVersion[], extra: Partial<PluginFile> = {}): PluginFile {
  return { id, name: id, description: `${id}, for tests`, versions, ...extra };
}

/** The Plugin file as `plugins/<id>.json` source. */
export const sourceOf = (plugin: object, file?: string) => ({
  file: file ?? `plugins/${(plugin as { id: string }).id}.json`,
  text: JSON.stringify(plugin, null, 2),
});

/** A temporary git repository holding `files`, committed with the given dates. */
export function gitRepo(name: string): {
  dir: string;
  write: (path: string, text: string) => void;
  commit: (message: string, date: string) => void;
} {
  const dir = resolve(WORK, "git", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);
  return {
    dir,
    write: (path, text) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    commit: (message, date) => {
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    },
  };
}
