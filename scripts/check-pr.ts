// The PR check's first job: every `plugins/*.json` against the schema and its file name, ids unique, Node Type and
// gate type names unique across Plugins, and, against the PR's base, no published version edited or removed. It
// downloads and runs nothing; it prints the artifacts of the versions the PR adds, as the load jobs' matrix.
//
//   node scripts/check-pr.ts [--base <git ref>] [--allow-removal]
//
// Without --base, every version counts as new (a full check of the repository).
import { execFileSync } from "node:child_process";
import {
  compareWithBase,
  loadPlan,
  nameClashes,
  parsePluginFiles,
  PLUGINS_DIR,
  readPluginFiles,
  type SourceFile,
  warningsFor,
} from "./lib/repository.ts";
import { argsOf, report, setOutput } from "./lib/report.ts";

/** `plugins/*.json` as they are at `ref`. */
function filesAt(root: string, ref: string): SourceFile[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return git("ls-tree", "--name-only", `${ref}:${PLUGINS_DIR}`)
    .split("\n")
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ file: `${PLUGINS_DIR}/${name}`, text: git("show", `${ref}:${PLUGINS_DIR}/${name}`) }));
}

export async function checkPr(root: string, { base, allowRemoval = false }: { base?: string; allowRemoval?: boolean }) {
  const { plugins, problems } = parsePluginFiles(await readPluginFiles(root));
  let baseFiles: SourceFile[] = [];
  if (base !== undefined)
    try {
      baseFiles = filesAt(root, base);
    } catch {
      baseFiles = []; // the base has no plugins/ folder yet
    }
  const { added, problems: changes, changed } = compareWithBase(baseFiles, plugins, { allowRemoval });
  problems.push(...changes);
  const established = new Set(
    baseFiles.map((f) => f.file.slice(PLUGINS_DIR.length + 1, -".json".length)),
  );
  problems.push(...nameClashes(plugins, established));
  const warnings = plugins
    .filter((p) => changed.has(p.plugin.id))
    .flatMap((p) => warningsFor(p, new Set(added.filter((a) => a.id === p.plugin.id).map((a) => a.version))));
  const plan = loadPlan(plugins, added);
  warnings.push(...plan.warnings);
  return { problems, warnings, added, jobs: plan.jobs };
}

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));
  const result = await checkPr(process.cwd(), { base: args.base, allowRemoval: args["allow-removal"] === "true" });
  report(result.problems, result.warnings);
  process.stdout.write(
    `${result.added.length === 0 ? "No new versions." : `New versions: ${result.added.map((a) => `${a.id}@${a.version}`).join(", ")}.`}\n`,
  );
  setOutput("matrix", JSON.stringify({ include: result.jobs }));
  setOutput("count", String(result.jobs.length));
  process.exit(result.problems.length > 0 ? 1 : 0);
}
