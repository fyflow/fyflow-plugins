// Rules 3 and 4: each new artifact downloaded, verified, unpacked, checked against its entry, and loaded as a Host
// loads it, with tarballs `fyflow-plugin pack` made from the fixture Plugins (and a few made by hand).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { checkArtifact } from "../scripts/lib/artifact.ts";
import type { PluginFile, PluginFileVersion } from "../scripts/lib/schema.ts";
import { download, integrityOf } from "../scripts/lib/tarball.ts";
import { fetchFrom, makeTgz, type Packed, packFixture, sdk, urlOf, WORK } from "./helpers.ts";

/** The Plugin file a packed fixture's entry makes, its names as given. */
function fileFor(packed: Packed, names: { nodeTypes: string[]; gateTypes: string[] }, change: Partial<PluginFileVersion> = {}) {
  const { id, ...entry } = packed.entry;
  const version = { ...entry, url: urlOf(id), names, ...change } as PluginFileVersion;
  const plugin: PluginFile = { id, name: id, description: "", versions: [version] };
  return { plugin, version };
}

let n = 0;
async function check(
  packed: Packed | { bytes: Uint8Array },
  plugin: PluginFile,
  version: PluginFileVersion,
  { artifact = 0, load = true } = {},
) {
  const url = version.artifacts?.[artifact]?.url ?? (version.url as string);
  return checkArtifact({
    plugin,
    version,
    artifact,
    load,
    sdkRoot: WORK,
    work: join(WORK, "checks", `${process.pid}-${n++}`),
    fetchBytes: fetchFrom({ [url]: packed.bytes }),
  });
}

const rules = (r: { problems: { rule: string }[] }) => r.problems.map((p) => p.rule);
const said = (r: { problems: { message: string }[] }) => r.problems.map((p) => p.message).join("\n");

const ECHO = { nodeTypes: ["TestEcho"], gateTypes: ["test-gate"] };
let echo: Packed;

before(async () => {
  await sdk();
  echo = await packFixture("echo");
});

describe("rule 3: the tarball is what its entry says", () => {
  it("takes the echo fixture: its integrity, package, and definition", async () => {
    const { plugin, version } = fileFor(echo, ECHO);
    assert.deepEqual(await check(echo, plugin, version), { problems: [], warnings: [] });
  });

  it("refuses a tarball whose SHA-512 is not the entry's integrity", async () => {
    const { plugin, version } = fileFor(echo, ECHO, { integrity: integrityOf(Buffer.from("other")) });
    const r = await check(echo, plugin, version);
    assert.deepEqual(rules(r), ["tarball"]);
    assert.match(said(r), /its SHA-512 is sha512-.*, not the entry's integrity/);
  });

  it("refuses a download that is not https, or is too large", async () => {
    await assert.rejects(download("http://example.test/a.tgz"), /is not https/);
    const big = new Response(new Uint8Array(10));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => Object.defineProperty(big, "url", { value: "https://example.test/a.tgz" });
    try {
      await assert.rejects(download("https://example.test/a.tgz", 5), /more than the 5 bytes/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a package.json version other than the entry's", async () => {
    const { plugin, version } = fileFor(echo, ECHO, { version: "1.0.1" });
    const r = await check(echo, plugin, version);
    assert.ok(rules(r).includes("package"));
    assert.match(said(r), /its package.json says version 1\.0\.0, the entry 1\.0\.1/);
  });

  it("refuses an sdk other than the package's peer range", async () => {
    const { plugin, version } = fileFor(echo, ECHO, { sdk: "^0.9.0" });
    const r = await check(echo, plugin, version);
    assert.deepEqual(rules(r), ["package"]);
    assert.match(said(r), /peer range is "\^0\.10\.0", the entry's sdk "\^0\.9\.0"/);
  });

  it("refuses a tarball that is not a gzipped tar, or reaches outside the Plugin", async () => {
    const notTar = { bytes: Buffer.from("not a tarball") };
    const v = { version: "1.0.0", sdk: "^0.10.0", python: false, url: urlOf("x"), integrity: integrityOf(notTar.bytes), names: ECHO } as PluginFileVersion;
    const plugin = { id: "test.x", name: "x", description: "", versions: [v] };
    assert.match(said(await check(notTar, plugin, v)), /not a gzipped archive/);
    const escaping = { bytes: makeTgz({ "../evil.js": "x", "package.json": "{}" }) };
    const v2 = { ...v, integrity: integrityOf(escaping.bytes) };
    assert.match(said(await check(escaping, { ...plugin, versions: [v2] }, v2)), /would land outside the Plugin/);
  });

  it("refuses a Plugin with dependencies and no npm-shrinkwrap.json", async () => {
    const bytes = makeTgz({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", peerDependencies: { "fyflow-plugin-sdk": "^0.10.0" }, dependencies: { ms: "2.1.3" } }),
      "plugin.js": "export default {}",
    });
    const v = { version: "1.0.0", sdk: "^0.10.0", python: false, url: urlOf("x"), integrity: integrityOf(bytes), names: ECHO } as PluginFileVersion;
    const r = await check({ bytes }, { id: "test.x", name: "x", description: "", versions: [v] }, v);
    assert.deepEqual(rules(r), ["shrinkwrap"]);
  });

  it("refuses a Python Plugin whose tarball has no pyproject.toml and uv.lock", async () => {
    const bytes = makeTgz({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", peerDependencies: { "fyflow-plugin-sdk": "^0.10.0" } }),
      "plugin.js": "export default {}",
      "python/pyproject.toml": "[project]",
    });
    const v = { version: "1.0.0", sdk: "^0.10.0", python: { variants: ["cpu"] }, url: urlOf("x"), integrity: integrityOf(bytes), names: ECHO } as PluginFileVersion;
    const r = await check({ bytes }, { id: "test.x", name: "x", description: "", versions: [v] }, v);
    assert.deepEqual(rules(r), ["python"]);
    assert.match(said(r), /no Python project with pyproject\.toml and uv\.lock/);
  });
});

describe("rule 4: the Plugin loads as a Host loads it, and is what its entry says", () => {
  it("refuses an entry for another id", async () => {
    const { plugin, version } = fileFor(echo, ECHO);
    const r = await check(echo, { ...plugin, id: "test.other" }, version);
    assert.deepEqual(rules(r), ["load"]);
    assert.match(said(r), /its definition's id is "test\.echo", not test\.other/);
  });

  it("refuses names other than the definition's", async () => {
    const { plugin, version } = fileFor(echo, { nodeTypes: ["TestEcho", "Extra"], gateTypes: [] });
    const r = await check(echo, plugin, version);
    assert.deepEqual(rules(r), ["names", "names"]);
    assert.match(said(r), /declares the Node Types \["TestEcho"\], and the entry's names\.nodeTypes \["TestEcho","Extra"\]/);
  });

  it("refuses a Plugin whose code fails to load, quoting the error", async () => {
    const bytes = makeTgz({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", type: "module", peerDependencies: { "fyflow-plugin-sdk": "^0.10.0" } }),
      "plugin.js": 'throw new Error("boom at import");',
    });
    const v = { version: "1.0.0", sdk: "^0.10.0", python: false, url: urlOf("x"), integrity: integrityOf(bytes), names: ECHO } as PluginFileVersion;
    const r = await check({ bytes }, { id: "test.x", name: "x", description: "", versions: [v] }, v);
    assert.deepEqual(rules(r), ["load"]);
    assert.match(said(r), /boom at import/);
  });

  it("does not run the code of an artifact no runner has the platform of", async () => {
    const { plugin, version } = fileFor(echo, ECHO);
    const r = await check(echo, { ...plugin, id: "test.other" }, version, { load: false });
    assert.deepEqual(r.problems, []);
  });

  it("loads a Plugin with npm dependencies after npm ci from its shrinkwrap", async () => {
    const deps = await packFixture("deps");
    const { plugin, version } = fileFor(deps, { nodeTypes: ["TestWait"], gateTypes: [] });
    assert.deepEqual(await check(deps, plugin, version), { problems: [], warnings: [] });
  });

  it("takes a Python Plugin with its project, and warns of __pycache__ in its tarball", async () => {
    const python = await packFixture("python");
    const names = { nodeTypes: ["TestCount"], gateTypes: [] };
    const good = fileFor(python, names);
    assert.deepEqual(good.version.python, { variants: ["cpu", "cuda"] });
    assert.deepEqual(await check(python, good.plugin, good.version), { problems: [], warnings: [] });

    const shipped = await packFixture("python", {
      change: (dir) => {
        // No `files`: npm packs everything, bytecode included.
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "fyflow-plugin-test-python", version: "0.3.0", type: "module", peerDependencies: { "fyflow-plugin-sdk": "^0.8.0" } }),
        );
        mkdirSync(join(dir, "python", "fixture_python", "__pycache__"), { recursive: true });
        writeFileSync(join(dir, "python", "fixture_python", "__pycache__", "count.cpython-312.pyc"), "x");
      },
    });
    const warned = fileFor(shipped, names);
    const r = await check(shipped, warned.plugin, warned.version);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings.map((w) => w.rule), ["python-files"]);
  });

  it("refuses an entry whose python is false for a Plugin with Python Workers", async () => {
    const python = await packFixture("python");
    const { plugin, version } = fileFor(python, { nodeTypes: ["TestCount"], gateTypes: [] }, { python: false });
    const r = await check(python, plugin, version);
    assert.deepEqual(rules(r), ["python"]);
    assert.match(said(r), /has Python Workers \(count\), and the entry's python is false/);
  });

  it("checks and loads each artifact of a version with one per platform", async () => {
    const linux = await packFixture("echo", { platforms: ["linux-x64"] });
    const win = await packFixture("echo", {
      platforms: ["win32-x64"],
      change: (dir) => writeFileSync(join(dir, "windows-only.txt"), "a binary, say"),
    });
    assert.match(linux.tarball, /-linux-x64\.tgz$/);
    const artifacts = [linux, win].map((p, i) => ({
      ...(p.entry.artifacts as { platforms: string[]; integrity: string }[])[0],
      url: urlOf(`echo-${i}`),
    })) as PluginFileVersion["artifacts"];
    const { id: _, artifacts: __, ...fields } = linux.entry;
    const version = { ...fields, artifacts, names: ECHO } as PluginFileVersion;
    const plugin = { id: "test.echo", name: "Echo", description: "", versions: [version] };
    assert.deepEqual(await check(linux, plugin, version, { artifact: 0 }), { problems: [], warnings: [] });
    assert.deepEqual(await check(win, plugin, version, { artifact: 1 }), { problems: [], warnings: [] });
    // The Linux tarball where the Windows one should be: its integrity is not the entry's.
    assert.deepEqual(rules(await check(linux, plugin, version, { artifact: 1 })), ["tarball"]);
  });
});
