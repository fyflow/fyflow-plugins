// A test fixture of fyflow-plugins' CI, in plain JS with no SDK import: never published.
export default {
  id: "test.clash",
  version: "2.0.0",
  base: import.meta.url,
  workers: { echo: { url: "./echo.worker.js" } },
  nodeTypes: { TestEcho: { worker: "echo" } },
};
