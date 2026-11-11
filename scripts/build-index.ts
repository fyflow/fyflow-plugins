// Builds the published site from `plugins/*.json`: `index.json`, the index a Host reads, and a plain `index.html`
// listing the Plugins. Each version's `published` is the time of the first commit that added it (git history: the
// same on every build, and no bot commit). `names` stay in the repository; the index has only the Host's keys. The
// result is validated against the Host's schema before anything is written.
//
//   node scripts/build-index.ts --out _site
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatFinding, parsePluginFiles, readPluginFiles } from "./lib/repository.ts";
import { argsOf } from "./lib/report.ts";
import { issuesOf, type PluginFile, type PluginIndex, PluginIndexSchema } from "./lib/schema.ts";

/**
 * When each version of a Plugin file was first committed: its committer date, ISO 8601 with offset. A version not
 * committed yet (a local build) has none.
 */
export function publishedTimes(root: string, file: string): Map<string, string> {
  const times = new Map<string, string>();
  let log: string;
  try {
    log = execFileSync("git", ["log", "--reverse", "--format=%H %cI", "--", file], { cwd: root, encoding: "utf8" });
  } catch {
    return times; // not a git checkout
  }
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, date] = line.split(" ") as [string, string];
    let versions: { version?: unknown }[] = [];
    try {
      versions = JSON.parse(execFileSync("git", ["show", `${sha}:${file}`], { cwd: root, encoding: "utf8" })).versions;
    } catch {
      continue; // a commit where it did not parse, or was deleted
    }
    for (const { version } of Array.isArray(versions) ? versions : [])
      if (typeof version === "string" && !times.has(version)) times.set(version, date);
  }
  return times;
}

/** The index a Host reads, from the Plugin files: sorted by id, `published` from git, without `names`. */
export function indexOf(plugins: readonly PluginFile[], published: (id: string) => Map<string, string>): PluginIndex {
  return {
    schema: 1,
    plugins: [...plugins]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ versions, ...fields }) => {
        const times = published(fields.id);
        return {
          ...fields,
          versions: versions.map(({ names: _, ...version }) => {
            const at = times.get(version.version);
            return at === undefined ? version : { ...version, published: at };
          }),
        };
      }),
  };
}

const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain page listing the Plugins, for people. */
export function pageOf(index: PluginIndex): string {
  const rows = index.plugins.map((p) => {
    const name = p.homepage ? `<a href="${html(p.homepage)}">${html(p.name)}</a>` : html(p.name);
    return `<tr><td>${name}<br><code>${html(p.id)}</code></td><td>${html(p.description)}</td><td>${p.versions
      .map((v) => html(v.version))
      .join(", ")}</td></tr>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fyflow Plugins</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #ddd; background: #161616; } a { color: #8ab4f8; } }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: .5rem; border-bottom: 1px solid #8884; }
  code { font-size: .85em; }
</style>
</head>
<body>
<h1>fyflow Plugins</h1>
<p>The official Plugin repository for <a href="https://github.com/fyflow/fyflow-app">fyflow</a>. A Host reads
<a href="index.json"><code>index.json</code></a>; install these from the Plugins page, under Browse.
To submit a Plugin, see <a href="https://github.com/fyflow/fyflow-plugins#readme">the repository</a>.</p>
${
  rows.length === 0
    ? "<p>No Plugins yet.</p>"
    : `<table>
<thead><tr><th>Plugin</th><th>What it does</th><th>Versions</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`
}
</body>
</html>
`;
}

/** Builds and validates the index from the repository at `root`; throws, naming each problem, when it cannot. */
export async function buildIndex(root: string): Promise<PluginIndex> {
  const { plugins, problems } = parsePluginFiles(await readPluginFiles(root));
  if (problems.length > 0) throw new Error(`plugins/ has problems:\n${problems.map(formatFinding).join("\n")}`);
  const index = indexOf(
    plugins.map((p) => p.plugin),
    (id) => publishedTimes(root, `plugins/${id}.json`),
  );
  const checked = PluginIndexSchema.safeParse(index);
  if (!checked.success)
    throw new Error(`the built index does not match the Host's schema:\n${issuesOf(checked.error).join("\n")}`);
  return index;
}

if (import.meta.main) {
  const out = argsOf(process.argv.slice(2)).out ?? "_site";
  const index = await buildIndex(process.cwd());
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(out, "index.html"), pageOf(index));
  await writeFile(join(out, ".nojekyll"), "");
  const versions = index.plugins.reduce((n, p) => n + p.versions.length, 0);
  process.stdout.write(`Built ${out}/index.json: ${index.plugins.length} Plugins, ${versions} versions.\n`);
}
