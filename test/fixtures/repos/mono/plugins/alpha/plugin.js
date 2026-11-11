// A test fixture of fyflow-plugins' release workflow: never published.
export default {
  id: "test.alpha",
  version: "1.0.0",
  base: import.meta.url,
  workers: { w: { url: "./w.js" } },
  nodeTypes: { TestAlpha: { worker: "w" } },
};
