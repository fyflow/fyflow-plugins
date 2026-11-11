// Run as `node load-child.ts <plugin folder>`: imports the Plugin's entry as a Host does (`plugin.ts`, else
// `plugin.js`, else its package's `exports`/`main`), takes its default export, and prints what it declares on one
// line after a marker. Its own process, so a Plugin's code cannot reach the checker's, and is killed if it hangs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MARKER } from "./load.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Copied from fyflow-plugin-sdk's `cli.ts` (`packageEntryOf`), which mirrors the Host's: the module a package's
// `import` loads, `exports` for `.`, else `main`, else index.js.
function packageEntryOf(manifest: Record<string, unknown>): string {
  const fromConditions = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (!isObject(value)) return undefined;
    if ("." in value) return fromConditions(value["."]);
    for (const condition of ["import", "node", "default"]) {
      const entry = fromConditions(value[condition]);
      if (entry !== undefined) return entry;
    }
    return undefined;
  };
  return fromConditions(manifest.exports) ?? (typeof manifest.main === "string" ? manifest.main : "index.js");
}

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: load-child.ts <plugin folder>");
const manifestPath = join(dir, "package.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const entry = ["plugin.ts", "plugin.js"].find((e) => existsSync(join(dir, e))) ?? packageEntryOf(manifest);
const definition = ((await import(pathToFileURL(join(dir, entry)).href)) as { default?: unknown }).default;
if (!isObject(definition)) throw new Error(`${entry} has no default export that is a Plugin definition`);

const keys = (v: unknown) => (isObject(v) ? Object.keys(v) : []);
const workers = isObject(definition.workers) ? definition.workers : {};
const python = isObject(definition.python) ? definition.python : null;
let pythonProject: string | null = null;
if (python !== null && typeof python.project === "string" && typeof definition.base === "string")
  try {
    pythonProject = fileURLToPath(new URL(python.project, definition.base));
  } catch {
    pythonProject = null;
  }

process.stdout.write(
  `\n${MARKER}${JSON.stringify({
    entry,
    id: definition.id,
    version: definition.version,
    nodeTypes: keys(definition.nodeTypes),
    gateTypes: keys(definition.gateTypes),
    pythonWorkers: Object.entries(workers)
      .filter(([, w]) => isObject(w) && w.python !== undefined)
      .map(([k]) => k),
    pythonProject,
  })}\n`,
  // A Plugin may leave timers or handles open at import: the definition is all that is wanted.
  () => process.exit(0),
);
