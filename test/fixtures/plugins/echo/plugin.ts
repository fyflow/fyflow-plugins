// A test fixture of fyflow-plugins' CI: never published.
import { definePlugin } from "fyflow-plugin-sdk";

export default definePlugin({
  id: "test.echo",
  version: "1.0.0",
  base: import.meta.url,
  workers: { echo: { url: "./echo.worker.js" } },
  nodeTypes: { TestEcho: { worker: "echo", description: "Returns its input." } },
  gateTypes: {
    "test-gate": { routes: ["yes", "no"], defaultRoute: "no", fn: () => "yes" as const },
  },
});
