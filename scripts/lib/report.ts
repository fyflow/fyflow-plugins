// Printing findings: plain lines, and on GitHub Actions also annotations on the file and a job summary.
import { appendFileSync } from "node:fs";
import { type Finding, formatFinding } from "./repository.ts";

const onActions = () => process.env.GITHUB_ACTIONS === "true";

/** Escapes a value for a workflow command (`::error ...::`). */
const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function report(problems: readonly Finding[], warnings: readonly Finding[]): void {
  for (const [level, findings] of [
    ["error", problems],
    ["warning", warnings],
  ] as const)
    for (const f of findings) {
      if (onActions()) {
        const title = [f.plugin, f.version, f.rule].filter(Boolean).join(" ");
        process.stdout.write(`::${level} file=${f.file},title=${escape(title)}::${escape(f.message)}\n`);
      }
      (level === "error" ? process.stderr : process.stdout).write(`${level}: ${formatFinding(f)}\n`);
    }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "" && problems.length + warnings.length > 0)
    appendFileSync(
      summary,
      [
        ...problems.map((f) => `- ❌ ${formatFinding(f).replace(/\n/g, " ")}`),
        ...warnings.map((f) => `- ⚠️ ${formatFinding(f).replace(/\n/g, " ")}`),
        "",
      ].join("\n"),
    );
}

/** Sets a step output (`GITHUB_OUTPUT`), when there is one. */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== "") appendFileSync(file, `${name}=${value}\n`);
}

/** `--name value` arguments. */
export function argsOf(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[arg.slice(2)] = "true";
    else {
      args[arg.slice(2)] = next;
      i++;
    }
  }
  return args;
}
