// A test fixture of fyflow-plugins' release workflow: never published.
export default {
  id: "test.built",
  version: "0.2.0",
  base: import.meta.url,
  workers: { w: { url: "./w.js" } },
  nodeTypes: { TestBuilt: { worker: "w" } },
};
