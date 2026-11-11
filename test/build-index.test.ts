// Publishing: index.json from plugins/*.json, `published` from git history, validated against the Host's schema.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIndex, indexOf, pageOf, publishedTimes } from "../scripts/build-index.ts";
import { PluginIndexSchema } from "../scripts/lib/schema.ts";
import { gitRepo, pluginFile, version } from "./helpers.ts";

describe("building index.json", () => {
  it("builds {schema: 1, plugins: []} from no Plugins, with no plugins/ folder at all", async () => {
    const repo = gitRepo("empty");
    assert.deepEqual(await buildIndex(repo.dir), { schema: 1, plugins: [] });
    repo.write("plugins/.gitkeep", "");
    repo.commit("start", "2026-11-11T10:00:00+00:00");
    const index = await buildIndex(repo.dir);
    assert.deepEqual(index, { schema: 1, plugins: [] });
    assert.ok(PluginIndexSchema.safeParse(index).success);
    assert.match(pageOf(index), /No Plugins yet/);
  });

  it("sets each version's published to the first commit that added it, and leaves names out", async () => {
    const repo = gitRepo("history");
    const one = pluginFile("acme.one", [version("1.0.0", { names: { nodeTypes: ["A"], gateTypes: [] } })]);
    repo.write("plugins/acme.one.json", JSON.stringify(one));
    repo.commit("acme.one 1.0.0", "2026-11-12T10:00:00+01:00");
    repo.write("plugins/acme.one.json", JSON.stringify({ ...one, description: "changed" }));
    repo.commit("describe it", "2026-11-13T10:00:00+00:00");
    repo.write("plugins/acme.one.json", JSON.stringify({ ...one, versions: [...one.versions, version("1.1.0")] }));
    repo.write("plugins/acme.two.json", JSON.stringify(pluginFile("acme.two", [version("0.1.0")])));
    repo.commit("acme.one 1.1.0, acme.two 0.1.0", "2026-11-14T08:30:00-05:00");
    repo.write("plugins/acme.three.json", JSON.stringify(pluginFile("acme.three", [version("3.0.0")])));

    const index = await buildIndex(repo.dir);
    assert.ok(PluginIndexSchema.safeParse(index).success);
    assert.deepEqual(
      index.plugins.map((p) => [p.id, p.versions.map((v) => [v.version, v.published])]),
      [
        ["acme.one", [["1.0.0", "2026-11-12T10:00:00+01:00"], ["1.1.0", "2026-11-14T08:30:00-05:00"]]],
        ["acme.three", [["3.0.0", undefined]]], // not committed: a local build
        ["acme.two", [["0.1.0", "2026-11-14T08:30:00-05:00"]]],
      ],
    );
    assert.ok(index.plugins.every((p) => p.versions.every((v) => !("names" in v))));
    assert.equal(publishedTimes(repo.dir, "plugins/acme.one.json").size, 2);
  });

  it("refuses to build from a file CI would refuse, naming it", async () => {
    const repo = gitRepo("bad");
    repo.write("plugins/acme.one.json", JSON.stringify(pluginFile("acme.one", [version("1.0")])));
    await assert.rejects(buildIndex(repo.dir), /plugins\/acme\.one\.json: acme\.one \[schema\] versions\[0\]\.version/);
  });

  it("validates what it builds against the Host's schema", () => {
    const built = indexOf([pluginFile("acme.one", [version("1.0.0")])], () => new Map([["1.0.0", "not a date"]]));
    assert.ok(!PluginIndexSchema.safeParse(built).success);
  });

  it("escapes what the page shows", () => {
    const page = pageOf({ schema: 1, plugins: [{ ...pluginFile("a.b", [version("1.0.0")]), name: "<script>" }] });
    assert.ok(!page.includes("<script>"));
    assert.match(page, /&lt;script&gt;/);
  });
});
