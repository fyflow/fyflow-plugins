// A test fixture of fyflow-plugins' CI: never published. Imports its dependency at load, so a missing install fails.
import ms from "ms";

export default {
  id: "test.deps",
  version: "1.1.0",
  base: import.meta.url,
  workers: { wait: { url: "./wait.worker.js" } },
  nodeTypes: { TestWait: { worker: "wait", description: `Waits up to ${ms(60_000)}.` } },
};
