// A load job of the PR check: one artifact of one new version, on a runner of its platform. Downloads it, verifies
// its integrity, checks what it holds, installs its dependencies and loads it as a Host does, and compares its
// definition (id, version, Node Types, gate types, Python) with the entry. It runs a stranger's code: the job that
// calls it has no token and no secret, and the code runs in a process of its own with a plain environment.
//
//   node scripts/check-artifact.ts --id <id> --version <version> --artifact <n> [--load false]
//
// The SDK is installed from FYFLOW_PLUGIN_SDK (an npm spec or a tarball's path; default fyflow-plugin-sdk@^0.10.0).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkArtifact } from "./lib/artifact.ts";
import { fileOf } from "./lib/repository.ts";
import { argsOf, report } from "./lib/report.ts";
import { PluginFileSchema } from "./lib/schema.ts";

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));
  const { id, version } = args;
  if (id === undefined || version === undefined) throw new Error("usage: check-artifact.ts --id <id> --version <v> --artifact <n>");
  const root = process.cwd();
  const plugin = PluginFileSchema.parse(JSON.parse(await readFile(join(root, fileOf(id)), "utf8")));
  const entry = plugin.versions.find((v) => v.version === version);
  if (entry === undefined) throw new Error(`${fileOf(id)} has no version ${version}`);
  const artifact = Number(args.artifact ?? 0);
  const sdkRoot = join(root, ".work");
  const result = await checkArtifact({
    plugin,
    version: entry,
    artifact,
    load: args.load !== "false",
    sdkRoot,
    work: join(sdkRoot, `${id}@${version}-${artifact}`),
  });
  report(result.problems, result.warnings);
  if (result.problems.length === 0)
    process.stdout.write(`${id} ${version} artifact ${artifact}: ${args.load === "false" ? "checked (not loaded)" : "checked and loaded"}.\n`);
  process.exit(result.problems.length > 0 ? 1 : 0);
}
