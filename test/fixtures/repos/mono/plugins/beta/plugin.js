// A test fixture of fyflow-plugins' release workflow: never published.
export default {
  id: "test.beta",
  version: "1.0.0",
  base: import.meta.url,
  workers: { w: { url: "./w.js" } },
  nodeTypes: { TestBeta: { worker: "w" } },
};
