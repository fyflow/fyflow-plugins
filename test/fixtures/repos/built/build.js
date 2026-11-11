// The fixture's build step: copies src/ into dist/ with the package.json npm packs.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
cpSync("src", "dist", { recursive: true });
writeFileSync(
  "dist/package.json",
  JSON.stringify({
    name: "fyflow-plugin-test-built",
    version: "0.2.0",
    description: "A test fixture built before it is packed: never published.",
    type: "module",
    peerDependencies: { "fyflow-plugin-sdk": "^0.10.0" },
  }, null, 2),
);
