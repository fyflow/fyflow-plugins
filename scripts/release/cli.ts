// The release workflow's steps, run in the author's repository (`--root`, default the current folder):
//
//   node cli.ts plan  --tag <id>@<version> [--platforms "<p,p> <p>"]     the pack jobs: a runner per platform group
//   node cli.ts pack  --tag <id>@<version> --out <dir> [--platforms <p,p>]   find the Plugin, pack it, write <dir>/*.result.json
//   node cli.ts merge --dist <dir> --repo <owner/repo> --out <release.json>  merge the packs into one version, with URLs
//   node cli.ts apply --release <release.json> --index <fyflow-plugins checkout>   add the version to plugins/<id>.json
//   node cli.ts check [--out <dir>]                                          pack every Plugin, as a check that each packs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { argsOf, setOutput } from "../lib/report.ts";
import { PluginFileSchema } from "../lib/schema.ts";
import {
  findPlugin,
  mergeResults,
  metaOf,
  packPlan,
  packPlugin,
  parseTag,
  pluginFolders,
  type PackResult,
  ReleaseRefused,
  shell,
  withVersion,
} from "./release.ts";

const required = (args: Record<string, string>, name: string) => {
  const value = args[name];
  if (value === undefined) throw new ReleaseRefused(`--${name} is required`);
  return value;
};

async function main([command, ...rest]: string[]): Promise<void> {
  const args = argsOf(rest);
  const root = resolve(args.root ?? ".");
  switch (command) {
    case "plan": {
      const tag = required(args, "tag").replace(/^refs\/tags\//, "");
      parseTag(tag);
      const jobs = packPlan(args.platforms ?? "");
      process.stdout.write(`${tag}: ${jobs.map((j) => `${j.platforms || "every platform"} on ${j.runner}`).join("; ")}\n`);
      setOutput("matrix", JSON.stringify({ include: jobs }));
      return;
    }
    case "pack": {
      const tag = required(args, "tag").replace(/^refs\/tags\//, "");
      const { id, version } = parseTag(tag);
      const out = resolve(required(args, "out"));
      const platforms = (args.platforms ?? "").split(/[\s,]+/).filter(Boolean);
      const found = await findPlugin(root, id, version);
      process.stderr.write(`${tag} is the Plugin in ${found.dir} (packing ${found.packDir})\n`);
      const { tarball, entry } = await packPlugin(resolve(root, found.packDir), out, platforms);
      if (entry.id !== id || entry.version !== version)
        throw new ReleaseRefused(`fyflow-plugin pack packed ${entry.id} ${entry.version}, not ${id} ${version}`);
      const result: PackResult = { tag, found, tarball: basename(tarball), entry };
      const file = join(out, `${basename(tarball, ".tgz")}.result.json`);
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      setOutput("tarball", tarball);
      return;
    }
    case "merge": {
      const dist = resolve(required(args, "dist"));
      const results = readdirSync(dist, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".result.json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dist, f), "utf8")) as PackResult);
      const merged = mergeResults(results, required(args, "repo"));
      // Checked as the repository will check it, before anything is released.
      withVersion(null, merged.meta, merged.version);
      const release = { tag: results[0]?.tag, ...merged };
      await writeFile(resolve(required(args, "out")), `${JSON.stringify(release, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
      return;
    }
    case "apply": {
      const release = JSON.parse(readFileSync(resolve(required(args, "release")), "utf8"));
      const index = resolve(required(args, "index"));
      const file = join(index, "plugins", `${release.meta.id}.json`);
      const existing = existsSync(file) ? PluginFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
      const updated = withVersion(existing, release.meta, release.version);
      await writeFile(file, `${JSON.stringify(updated, null, 2)}\n`);
      process.stdout.write(`${existing === null ? "added" : "updated"} plugins/${release.meta.id}.json\n`);
      setOutput("new-plugin", String(existing === null));
      return;
    }
    case "check": {
      const out = args.out ? resolve(args.out) : await mkdtemp(join(tmpdir(), "fyflow-pack-"));
      const folders = pluginFolders(root);
      if (folders.length === 0) throw new ReleaseRefused("no Plugin here: neither a package.json at the root nor plugins/*/package.json");
      for (const dir of folders) {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (manifest.fyflow?.build !== undefined) await shell(manifest.fyflow.build, dir, `building ${dir}`);
        const packDir = resolve(dir, manifest.fyflow?.pack ?? ".");
        const { tarball, entry } = await packPlugin(packDir, out);
        process.stdout.write(`${entry.id} ${entry.version} packs: ${tarball} (${metaOf(entry.id, manifest).name})\n`);
      }
      return;
    }
    default:
      throw new ReleaseRefused(`unknown command ${String(command)}: pack, merge, apply or check`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ReleaseRefused)) throw error;
  process.stderr.write(`::error title=fyflow release::${error.message.replace(/\n/g, "%0A")}\n${error.message}\n`);
  process.exit(1);
}
