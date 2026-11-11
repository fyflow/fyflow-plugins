// A test fixture of fyflow-plugins' CI: never published. Its Python is never run.
import { definePlugin } from "fyflow-plugin-sdk";

export default definePlugin({
  id: "test.python",
  version: "0.3.0",
  base: import.meta.url,
  python: { project: "./python", variants: { cuda: ["cuda"] } },
  workers: { count: { python: "fixture_python.count:Count" } },
  nodeTypes: { TestCount: { worker: "count" } },
});
