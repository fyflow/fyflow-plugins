// The checks that need no download (rules 1, 2, 5 and the warnings), each with a good and a bad case.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareWithBase,
  loadPlan,
  nameClashes,
  parsePluginFiles,
  warningsFor,
} from "../scripts/lib/repository.ts";
import { PluginIndexSchema } from "../scripts/lib/schema.ts";
import { pluginFile, sourceOf, urlOf, version } from "./helpers.ts";

const rulesOf = (problems: { rule: string }[]) => problems.map((p) => p.rule);
const messages = (problems: { message: string }[]) => problems.map((p) => p.message).join("\n");
const parse = (...plugins: object[]) => parsePluginFiles(plugins.map((p) => sourceOf(p)));

describe("rule 1: each file parses, matches the schema and is named for its id", () => {
  it("takes a valid file in each artifact form", () => {
    const { plugins, problems } = parse(
      pluginFile("acme.one", [version("1.0.0"), version("1.1.0", { platforms: ["darwin", "linux"] })], {
        homepage: "https://example.test/one",
        icon: "image",
      }),
      pluginFile("acme.two", [
        {
          ...version("2.0.0"),
          url: undefined,
          integrity: undefined,
          artifacts: [
            { platforms: ["win32-x64"], url: urlOf("w"), integrity: version("1.0.0").integrity as string },
            { platforms: ["darwin-arm64", "darwin-x64"], url: urlOf("d"), integrity: version("2.0.0").integrity as string },
          ],
        },
      ]),
    );
    assert.deepEqual(problems, []);
    assert.equal(plugins.length, 2);
  });

  it("refuses a file that is not JSON", () => {
    const { problems } = parsePluginFiles([{ file: "plugins/a.json", text: "{ nope" }]);
    assert.deepEqual(rulesOf(problems), ["json"]);
    assert.match(problems[0]?.message ?? "", /is not JSON/);
  });

  it("refuses a file not named for its id", () => {
    const { problems } = parsePluginFiles([sourceOf(pluginFile("acme.one", [version("1.0.0")]), "plugins/acme.json")]);
    assert.deepEqual(rulesOf(problems), ["file-name"]);
    assert.match(problems[0]?.message ?? "", /rename it to plugins\/acme\.one\.json/);
  });

  it("refuses two ids that differ only in case", () => {
    const { problems } = parse(pluginFile("acme.one", [version("1.0.0")]), pluginFile("Acme.One", [version("1.0.0")]));
    assert.deepEqual(rulesOf(problems), ["unique-id"]);
  });

  const refuses = (what: string, plugin: object, pattern: RegExp) =>
    it(`refuses ${what}`, () => {
      const { problems } = parse(plugin);
      assert.ok(problems.length > 0, "expected a refusal");
      assert.ok(problems.every((p) => p.rule === "schema"));
      assert.match(messages(problems), pattern);
    });

  refuses("a version listed twice", pluginFile("a.b", [version("1.0.0"), version("1.0.0")]), /a\.b 1\.0\.0 is listed twice/);
  refuses("no versions", pluginFile("a.b", []), /versions/);
  refuses("an empty name", pluginFile("a.b", [version("1.0.0")], { name: "" }), /name/);
  refuses("a version that is not x.y.z", pluginFile("a.b", [version("1.0")]), /a version is x\.y\.z/);
  refuses("an http URL", pluginFile("a.b", [version("1.0.0", { url: "http://example.test/a.tgz" })]), /https URLs only/);
  refuses("an http homepage", pluginFile("a.b", [version("1.0.0")], { homepage: "http://example.test" }), /https/);
  refuses("a bad integrity", pluginFile("a.b", [version("1.0.0", { integrity: "sha1-abc" })]), /sha512-<base64/);
  refuses("python that is true", pluginFile("a.b", [version("1.0.0", { python: true as never })]), /python/);
  refuses("an empty sdk", pluginFile("a.b", [version("1.0.0", { sdk: "" })]), /sdk/);
  refuses(
    "url and artifacts both",
    pluginFile("a.b", [
      version("1.0.0", {
        artifacts: [{ platforms: ["linux"], url: urlOf("l"), integrity: version("1.0.0").integrity as string }],
      }),
    ]),
    /never both/,
  );
  refuses("neither url nor artifacts", pluginFile("a.b", [version("1.0.0", { url: undefined })]), /has url, or artifacts/);
  refuses(
    "an artifact without platforms",
    pluginFile("a.b", [
      version("1.0.0", {
        url: undefined,
        integrity: undefined,
        artifacts: [{ url: urlOf("l"), integrity: version("1.0.0").integrity } as never],
      }),
    ]),
    /artifacts\[0\]\.platforms/,
  );
  refuses("a platform named twice", pluginFile("a.b", [version("1.0.0", { platforms: ["linux", "linux"] })]), /names linux twice/);
  refuses(
    "overlapping artifacts",
    pluginFile("a.b", [
      version("1.0.0", {
        url: undefined,
        integrity: undefined,
        artifacts: [
          { platforms: ["linux"], url: urlOf("a"), integrity: version("1.0.0").integrity as string },
          { platforms: ["linux-x64"], url: urlOf("b"), integrity: version("1.0.0").integrity as string },
        ],
      }),
    ]),
    /names linux and linux-x64 in two artifacts/,
  );
  refuses("a platform in capitals", pluginFile("a.b", [version("1.0.0", { platforms: ["Linux"] })]), /<os> or <os>-<cpu>/);
  refuses(
    "published, which the repository sets",
    pluginFile("a.b", [version("1.0.0", { published: "2026-11-12T10:00:00Z" } as never)]),
    /leave it out/,
  );
  refuses("a version's id", pluginFile("a.b", [version("1.0.0", { id: "a.b" } as never)]), /a version has no `id`/);
  refuses("a misspelt key", pluginFile("a.b", [version("1.0.0")], { descripton: "x" } as never), /unknown key "descripton"/);
  refuses("a version without names", pluginFile("a.b", [version("1.0.0", { names: undefined })]), /names/);

  it("names the file, Plugin, version and rule in a refusal", () => {
    const { problems } = parse(pluginFile("a.b", [version("1.0")]));
    assert.equal(problems[0]?.file, "plugins/a.b.json");
    assert.equal(problems[0]?.plugin, "a.b");
    assert.match(problems[0]?.message ?? "", /^versions\[0\]\.version: /);
  });

  it("agrees with the Host's index schema on an empty index", () => {
    assert.ok(PluginIndexSchema.safeParse({ schema: 1, plugins: [] }).success);
    assert.ok(!PluginIndexSchema.safeParse({ schema: 2, plugins: [] }).success);
  });
});

describe("rule 2: published versions are immutable", () => {
  const base = pluginFile("acme.one", [version("1.0.0")]);
  const head = (plugin: object) => parse(plugin).plugins;

  it("takes a new version, and a change to the Plugin's fields", () => {
    const after = { ...base, description: "Better words", versions: [...base.versions, version("1.1.0")] };
    const { added, problems } = compareWithBase([sourceOf(base)], head(after));
    assert.deepEqual(problems, []);
    assert.deepEqual(added, [{ id: "acme.one", version: "1.1.0" }]);
  });

  it("takes a new Plugin, all its versions new", () => {
    const { added, problems } = compareWithBase([], head(base));
    assert.deepEqual(problems, []);
    assert.deepEqual(added, [{ id: "acme.one", version: "1.0.0" }]);
  });

  for (const [key, value] of [
    ["url", urlOf("other")],
    ["integrity", version("9.9.9").integrity],
    ["sdk", "^0.9.0"],
    ["platforms", ["linux"]],
    ["python", { variants: ["cpu"] }],
    ["names", { nodeTypes: ["X"], gateTypes: [] }],
  ] as const)
    it(`refuses a change to a published version's ${key}`, () => {
      const after = { ...base, versions: [version("1.0.0", { [key]: value })] };
      const { problems } = compareWithBase([sourceOf(base)], head(after));
      assert.deepEqual(rulesOf(problems), ["immutable"]);
      assert.match(problems[0]?.message ?? "", new RegExp(`changes a published version \\(${key}\\)`));
    });

  it("refuses moving a version to artifacts", () => {
    const after = {
      ...base,
      versions: [
        version("1.0.0", {
          url: undefined,
          integrity: undefined,
          artifacts: [{ platforms: ["linux"], url: base.versions[0]?.url as string, integrity: base.versions[0]?.integrity as string }],
        }),
      ],
    };
    const { problems } = compareWithBase([sourceOf(base)], head(after));
    assert.deepEqual(rulesOf(problems), ["immutable"]);
  });

  it("takes the same version with its keys in another order", () => {
    const [v] = base.versions;
    const reordered = Object.fromEntries(Object.entries(v as object).reverse());
    const { problems } = compareWithBase([sourceOf(base)], head({ ...base, versions: [reordered] }));
    assert.deepEqual(problems, []);
  });

  it("refuses removing a version or a Plugin, unless a maintainer allows it", () => {
    const two = pluginFile("acme.one", [version("1.0.0"), version("1.1.0")]);
    const removedVersion = compareWithBase([sourceOf(two)], head(base));
    assert.deepEqual(rulesOf(removedVersion.problems), ["immutable"]);
    assert.match(removedVersion.problems[0]?.message ?? "", /removes a published version/);
    const removedPlugin = compareWithBase([sourceOf(base)], []);
    assert.match(removedPlugin.problems[0]?.message ?? "", /removes a published Plugin/);
    assert.deepEqual(compareWithBase([sourceOf(two)], head(base), { allowRemoval: true }).problems, []);
    assert.deepEqual(compareWithBase([sourceOf(base)], [], { allowRemoval: true }).problems, []);
  });

  it("never allows editing, even for a maintainer's removal", () => {
    const after = { ...base, versions: [version("1.0.0", { sdk: "^0.9.0" })] };
    assert.equal(compareWithBase([sourceOf(base)], head(after), { allowRemoval: true }).problems.length, 1);
  });
});

describe("rule 5: Node Type and gate type names are unique across Plugins", () => {
  const withNames = (id: string, nodeTypes: string[], gateTypes: string[] = [], v = "1.0.0") =>
    pluginFile(id, [version(v, { names: { nodeTypes, gateTypes } })]);

  it("takes distinct names, and a Plugin keeping its own across versions", () => {
    const a = pluginFile("acme.a", [
      version("1.0.0", { names: { nodeTypes: ["Resize"], gateTypes: ["size"] } }),
      version("1.1.0", { names: { nodeTypes: ["Resize", "Crop"], gateTypes: ["size"] } }),
    ]);
    assert.deepEqual(nameClashes(parse(a, withNames("acme.b", ["Blur"], ["blurry"])).plugins), []);
  });

  it("refuses a Node Type name another Plugin has, in any of its versions", () => {
    const a = pluginFile("acme.a", [
      version("1.0.0", { names: { nodeTypes: ["Old"], gateTypes: [] } }),
      version("2.0.0", { names: { nodeTypes: ["Resize"], gateTypes: [] } }),
    ]);
    const problems = nameClashes(parse(a, withNames("zeta.b", ["Old"])).plugins, new Set(["acme.a"]));
    assert.deepEqual(rulesOf(problems), ["names"]);
    assert.equal(problems[0]?.plugin, "zeta.b");
    assert.match(problems[0]?.message ?? "", /Node Type "Old" is already acme\.a's/);
  });

  it("blames the Plugin the base did not have, whatever their order", () => {
    const problems = nameClashes(parse(withNames("aaa.new", ["Resize"]), withNames("zzz.old", ["Resize"])).plugins, new Set(["zzz.old"]));
    assert.equal(problems[0]?.plugin, "aaa.new");
  });

  it("refuses a gate type name another Plugin has", () => {
    const problems = nameClashes(parse(withNames("acme.a", [], ["route"]), withNames("acme.b", [], ["route"])).plugins);
    assert.match(problems[0]?.message ?? "", /gate type "route" is already acme\.a's/);
  });

  it("takes a Node Type and a gate type of one name: they are different kinds", () => {
    assert.deepEqual(nameClashes(parse(withNames("acme.a", ["Same"]), withNames("acme.b", [], ["Same"])).plugins), []);
  });
});

describe("rule 6: warnings, not refusals", () => {
  const checked = (plugin: object) => parse(plugin).plugins[0] as NonNullable<ReturnType<typeof parse>["plugins"][0]>;

  it("warns of an icon the app does not have, and not of one it has", () => {
    assert.deepEqual(warningsFor(checked(pluginFile("a.b", [version("1.0.0")], { icon: "image" }))), []);
    const warnings = warningsFor(checked(pluginFile("a.b", [version("1.0.0")], { icon: "unicorn" })));
    assert.deepEqual(rulesOf(warnings), ["icon"]);
  });

  it("warns of an sdk range no current Host admits", () => {
    for (const sdk of ["^0.5.0", "^0.10.0", ">=0.6.0", "0.9.x"])
      assert.deepEqual(warningsFor(checked(pluginFile("a.b", [version("1.0.0", { sdk })]))), [], sdk);
    for (const [sdk, pattern] of [
      ["^0.4.0", /admits none/],
      ["^1.0.0", /admits none/],
      ["0.5.0 - 0.9.0", /cannot be read/],
    ] as const) {
      const warnings = warningsFor(checked(pluginFile("a.b", [version("1.0.0", { sdk })])));
      assert.deepEqual(rulesOf(warnings), ["sdk"], sdk);
      assert.match(warnings[0]?.message ?? "", pattern);
    }
  });
});

describe("the load plan", () => {
  it("loads each artifact on a runner of each platform it names, and one for every platform on Linux", () => {
    const integrity = version("1.0.0").integrity as string;
    const { plugins } = parse(
      pluginFile("a.b", [
        version("1.0.0"),
        version("1.1.0", { platforms: ["darwin", "linux"] }),
        version("2.0.0", {
          url: undefined,
          integrity: undefined,
          artifacts: [
            { platforms: ["win32-x64"], url: urlOf("w"), integrity },
            { platforms: ["darwin-arm64", "darwin-x64"], url: urlOf("d"), integrity },
            { platforms: ["freebsd"], url: urlOf("f"), integrity },
          ],
        }),
      ]),
    );
    const added = ["1.0.0", "1.1.0", "2.0.0"].map((v) => ({ id: "a.b", version: v }));
    const { jobs, warnings } = loadPlan(plugins, added);
    assert.deepEqual(
      jobs.map((j) => [j.version, j.artifact, j.runner, j.platforms, j.load]),
      [
        ["1.0.0", 0, "ubuntu-latest", "any", true],
        ["1.1.0", 0, "macos-latest", "darwin", true],
        ["1.1.0", 0, "ubuntu-latest", "linux", true],
        ["2.0.0", 0, "windows-latest", "win32-x64", true],
        ["2.0.0", 1, "macos-latest", "darwin-arm64", true],
        ["2.0.0", 1, "macos-15-intel", "darwin-x64", true],
        ["2.0.0", 2, "ubuntu-latest", "freebsd", false],
      ],
    );
    assert.deepEqual(rulesOf(warnings), ["platform"]);
  });
});
