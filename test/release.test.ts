// The release workflow's scripts: the tag, finding the Plugin for it (one Plugin, a monorepo, a built Plugin),
// packing, merging the platforms' entries, and the version a fyflow-plugins checkout gets, which its CI then takes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { checkPr } from "../scripts/check-pr.ts";
import { checkArtifact } from "../scripts/lib/artifact.ts";
import { PluginFileSchema } from "../scripts/lib/schema.ts";
import {
  assetUrl,
  findPlugin,
  mergeResults,
  packPlan,
  metaOf,
  type PackResult,
  parseTag,
  withVersion,
} from "../scripts/release/release.ts";
import { copyFixture, packCommandForTests, ROOT, sdk, version, WORK } from "./helpers.ts";

const CLI = join(ROOT, "scripts", "release", "cli.ts");

before(async () => {
  await sdk();
  process.env.FYFLOW_PLUGIN_PACK = await packCommandForTests();
});

describe("the tag", () => {
  it("reads <id>@<version>, the id with dots", () => {
    assert.deepEqual(parseTag("fyflow-ext.image-tags@0.1.0"), { id: "fyflow-ext.image-tags", version: "0.1.0" });
    assert.deepEqual(parseTag("refs/tags/acme.x@1.2.3-rc.1"), { id: "acme.x", version: "1.2.3-rc.1" });
    assert.deepEqual(parseTag("@scope.x@1.0.0"), { id: "@scope.x", version: "1.0.0" });
  });

  it("refuses a tag that is not <id>@<version>", () => {
    for (const tag of ["v1.0.0", "acme.x@1.0", "@1.0.0", "acme.x@latest"])
      assert.throws(() => parseTag(tag), /is not <id>@<version>/, tag);
  });

  it("makes the Release asset URL, the tag's @ encoded", () => {
    assert.equal(
      assetUrl("fyflow/fyflow-plugin-image-tags", "fyflow-ext.image-tags@0.1.0", "fyflow-plugin-image-tags-0.1.0.tgz"),
      "https://github.com/fyflow/fyflow-plugin-image-tags/releases/download/fyflow-ext.image-tags%400.1.0/fyflow-plugin-image-tags-0.1.0.tgz",
    );
  });
});

describe("finding the Plugin a tag names", () => {
  it("finds a Plugin at the repository root, with its fields and names", async () => {
    const dir = copyFixture("plugins/echo");
    const found = await findPlugin(dir, "test.echo", "1.0.0");
    assert.deepEqual(found, {
      dir: ".",
      packDir: ".",
      meta: { id: "test.echo", name: "Test echo", description: "A test fixture: never published.", icon: "repeat" },
      names: { nodeTypes: ["TestEcho"], gateTypes: ["test-gate"] },
    });
  });

  it("finds one of plugins/* in a monorepo whose Plugins share a version", async () => {
    const dir = copyFixture("repos/mono");
    const found = await findPlugin(dir, "test.beta", "1.0.0");
    assert.equal(found.dir, "plugins/beta");
    assert.equal(found.meta.homepage, "https://github.com/example/fixture-monorepo");
    assert.deepEqual(found.names.nodeTypes, ["TestBeta"]);
  });

  it("builds a Plugin with fyflow.build and packs its fyflow.pack folder", async () => {
    const dir = copyFixture("repos/built");
    const found = await findPlugin(dir, "test.built", "0.2.0");
    assert.equal(found.packDir, "dist");
    assert.ok(existsSync(join(dir, "dist", "package.json")));
    assert.deepEqual(found.meta, {
      id: "test.built",
      name: "Test built",
      description: "",
      homepage: "https://github.com/example/fixture-built",
    });
  });

  it("refuses a tag whose version no package.json has, and an id no Plugin has", async () => {
    const dir = copyFixture("repos/mono");
    await assert.rejects(findPlugin(dir, "test.beta", "9.9.9"), /no Plugin folder .* has a package\.json with version 9\.9\.9/);
    await assert.rejects(findPlugin(dir, "test.gamma", "1.0.0"), /no Plugin here is test\.gamma 1\.0\.0[\s\S]*plugins\/alpha: test\.alpha 1\.0\.0/);
  });
});

/** A pack job's result, as `cli.ts pack` writes it. */
const result = (tarball: string, entry: object, names = { nodeTypes: ["A"], gateTypes: [] as string[] }): PackResult => ({
  tag: "acme.x@1.0.0",
  found: { dir: ".", packDir: ".", meta: metaOf("acme.x", { name: "x", description: "X" }), names },
  tarball,
  entry: { id: "acme.x", version: "1.0.0", sdk: "^0.10.0", python: false, ...entry } as PackResult["entry"],
});
const integrity = version("1.0.0").integrity as string;

describe("merging the packs into one version", () => {
  it("fills one tarball's URL", () => {
    const { version: v, assets } = mergeResults([result("x-1.0.0.tgz", { url: "", integrity, platforms: ["linux"] })], "acme/x");
    assert.equal(v.url, "https://github.com/acme/x/releases/download/acme.x%401.0.0/x-1.0.0.tgz");
    assert.deepEqual(v.platforms, ["linux"]);
    assert.deepEqual(assets, ["x-1.0.0.tgz"]);
    assert.ok(!("id" in v));
  });

  it("merges the platforms' artifacts, each with its URL", () => {
    const { version: v } = mergeResults(
      [
        result("x-1.0.0-win32-x64.tgz", { artifacts: [{ platforms: ["win32-x64"], url: "", integrity }] }),
        result("x-1.0.0-darwin-arm64_darwin-x64.tgz", { artifacts: [{ platforms: ["darwin-arm64", "darwin-x64"], url: "", integrity }] }),
      ],
      "acme/x",
    );
    assert.deepEqual(
      v.artifacts?.map((a) => [a.platforms, a.url.split("/").at(-1)]),
      [
        [["win32-x64"], "x-1.0.0-win32-x64.tgz"],
        [["darwin-arm64", "darwin-x64"], "x-1.0.0-darwin-arm64_darwin-x64.tgz"],
      ],
    );
    assert.equal(v.url, undefined);
  });

  it("refuses platforms whose packs disagree on their names or sdk, or mix the two forms", () => {
    const win = result("w.tgz", { artifacts: [{ platforms: ["win32"], url: "", integrity }] });
    const mac = (change: object, names?: { nodeTypes: string[]; gateTypes: string[] }) =>
      result("m.tgz", { artifacts: [{ platforms: ["darwin"], url: "", integrity }], ...change }, names);
    assert.throws(() => mergeResults([win, mac({}, { nodeTypes: ["B"], gateTypes: [] })], "a/x"), /disagree on the Node Types and gate types/);
    assert.throws(() => mergeResults([win, mac({ sdk: "^0.9.0" })], "a/x"), /disagree on the sdk range/);
    assert.throws(() => mergeResults([win, result("o.tgz", { url: "", integrity })], "a/x"), /some tarballs were packed with --platform/);
  });

  it("adds the version to the Plugin's file, refusing one it has", () => {
    const { meta, version: v } = mergeResults([result("x.tgz", { url: "", integrity })], "acme/x");
    const first = withVersion(null, meta, v);
    assert.deepEqual(first.versions.map((x) => x.version), ["1.0.0"]);
    const second = withVersion(first, { ...meta, description: "Newer words" }, { ...v, version: "1.1.0" });
    assert.deepEqual(second.versions.map((x) => x.version), ["1.0.0", "1.1.0"]);
    assert.equal(second.description, "Newer words");
    assert.throws(() => withVersion(first, meta, v), /acme\.x 1\.0\.0 is in the repository already/);
  });
});

describe("the release, end to end without GitHub", () => {
  it("packs a tagged Plugin, merges it, applies it to a fyflow-plugins checkout, whose CI takes it", async () => {
    const author = copyFixture("repos/mono");
    const dist = join(WORK, "release-dist", String(process.pid));
    rmSync(dist, { recursive: true, force: true });
    const node = (args: string[], cwd: string) =>
      execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    node(["pack", "--tag", "test.alpha@1.0.0", "--out", dist], author);
    node(["merge", "--dist", dist, "--repo", "example/fixture-monorepo", "--out", join(dist, "release.json")], author);
    const release = JSON.parse(readFileSync(join(dist, "release.json"), "utf8"));
    assert.equal(release.tag, "test.alpha@1.0.0");
    assert.deepEqual(release.assets, ["fyflow-plugin-test-alpha-1.0.0.tgz"]);

    const index = join(WORK, "release-index", String(process.pid));
    rmSync(index, { recursive: true, force: true });
    mkdirSync(join(index, "plugins"), { recursive: true });
    assert.match(node(["apply", "--release", join(dist, "release.json"), "--index", index], author), /added plugins\/test\.alpha\.json/);
    const plugin = PluginFileSchema.parse(JSON.parse(readFileSync(join(index, "plugins", "test.alpha.json"), "utf8")));

    // What the index's PR check does with it: the static checks, then the artifact, served from the pack's output.
    const pr = await checkPr(index, {});
    assert.deepEqual(pr.problems, []);
    assert.deepEqual(pr.jobs.map((j) => [j.id, j.version, j.runner]), [["test.alpha", "1.0.0", "ubuntu-latest"]]);
    const v = plugin.versions[0] as (typeof plugin.versions)[0];
    const bytes = readFileSync(join(dist, "fyflow-plugin-test-alpha-1.0.0.tgz"));
    const checked = await checkArtifact({
      plugin,
      version: v,
      artifact: 0,
      load: true,
      sdkRoot: WORK,
      work: join(WORK, "checks", `release-${process.pid}`),
      fetchBytes: async () => bytes,
    });
    assert.deepEqual(checked, { problems: [], warnings: [] });

    // A second release of the same version is refused before anything is published.
    assert.throws(() => node(["apply", "--release", join(dist, "release.json"), "--index", index], author), /is in the repository already/);
  });

  it("checks that every Plugin of a repository packs", () => {
    const author = copyFixture("repos/mono");
    const out = execFileSync(process.execPath, [CLI, "check"], { cwd: author, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /test\.alpha 1\.0\.0 packs/);
    assert.match(out, /test\.beta 1\.0\.0 packs/);
  });

  it("checks a repository whose one Plugin is built first", () => {
    const author = copyFixture("repos/built");
    writeFileSync(join(author, "unrelated.txt"), "");
    const out = execFileSync(process.execPath, [CLI, "check"], { cwd: author, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /test\.built 0\.2\.0 packs/);
  });
});

describe("the pack jobs for the platforms input", () => {
  it("packs once on Linux for every platform, else once per group on its runner", () => {
    assert.deepEqual(packPlan(""), [{ platforms: "", runner: "ubuntu-latest" }]);
    assert.deepEqual(packPlan("win32-x64 darwin-arm64,darwin-x64\nlinux-x64"), [
      { platforms: "win32-x64", runner: "windows-latest" },
      { platforms: "darwin-arm64,darwin-x64", runner: "macos-latest" },
      { platforms: "linux-x64", runner: "ubuntu-latest" },
    ]);
  });

  it("refuses a group no one runner packs, and a platform misspelt", () => {
    assert.throws(() => packPlan("win32-x64,linux-x64"), /not packed on one GitHub runner/);
    assert.throws(() => packPlan("Windows"), /is not <os> or <os>-<cpu>/);
  });
});
