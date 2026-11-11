# fyflow-plugins

The official Plugin repository for [fyflow](https://github.com/fyflow/fyflow-app). Every fyflow Host reads its index unless configured otherwise:

**https://fyflow.github.io/fyflow-plugins/index.json**

A Host lists the Plugins here on its Plugins page, under Browse, and installs and updates them from there. This repository holds:

- `plugins/<id>.json`: one file per Plugin, with its versions. The index is built from these.
- The CI that admits a Plugin or a version: a PR check, and a publish job that builds `index.json` and deploys it to GitHub Pages.
- `release-plugin.yml` and `check-plugin.yml`: reusable workflows that Plugin authors call from their own repositories to pack, release and submit a version.

## What belongs here

Plugins that do real work: something a person would install to get a job done. No examples, demos, tests or templates. fyflow-app's own `examples/plugins/` are its test fixtures and are not published, and neither are this repository's fixtures under `test/`.

**An id is permanent.** Once a version is published under an id, the id belongs to that Plugin for good: Flows record the Plugins they use by id. Namespace yours (`acme.tagger`, not `tagger`).

## Submitting a Plugin or a new version

You need a Plugin that `fyflow-plugin pack` packs: see the SDK README, [Packing a Plugin](https://github.com/fyflow/fyflow-app/blob/main/packages/plugin-sdk/README.md#packing-a-plugin) and [Publishing to the official repository](https://github.com/fyflow/fyflow-app/blob/main/packages/plugin-sdk/README.md#publishing-to-the-official-repository).

### With the release workflow (recommended)

Add `.github/workflows/release.yml` to your Plugin's repository:

```yaml
name: Release
on:
  push:
    tags: ["*@*"] # <id>@<version>, e.g. acme.tagger@1.0.0
jobs:
  release:
    permissions:
      contents: write # the GitHub Release, in your repository
    uses: fyflow/fyflow-plugins/.github/workflows/release-plugin.yml@v1
    secrets:
      FYFLOW_PLUGINS_TOKEN: ${{ secrets.FYFLOW_PLUGINS_TOKEN }}
```

Then push a tag `<id>@<version>`, such as `acme.tagger@1.0.0`. The id may contain dots. The version must equal the one in the Plugin's `package.json` and its definition. The workflow:

1. finds the Plugin whose definition has that id and version: the repository root, or one of `plugins/*/` in a monorepo;
2. installs your dependencies (`pnpm install --frozen-lockfile` with a `pnpm-lock.yaml`, `npm ci` with a `package-lock.json`, or your `install` input), builds the Plugin if it says how (below), and runs `fyflow-plugin pack`;
3. creates a GitHub Release for the tag, with the tarball as its asset;
4. fills in the entry's `url` with the asset's download URL (`https://github.com/<you>/<repo>/releases/download/<id>%40<version>/<tarball>`);
5. opens a PR against this repository adding the version, or the Plugin's file for its first version.

**The secret.** `FYFLOW_PLUGINS_TOKEN` lets the workflow fork this repository and open the PR. Use a **classic personal access token with the `public_repo` scope**: a fine-grained token cannot open a PR on a repository its owner does not own. For a token that can push to this repository (a maintainer's), the workflow pushes the branch here instead of to a fork. Without the secret, the workflow still makes the Release, then prints the entry in the run's summary and stops: open the PR by hand, as below.

**What the workflow reads from your `package.json`.** The Plugin's fields in the index come from its package: `description`; `homepage` (an https URL, else the GitHub `repository`); and, under a `"fyflow"` key, `name` (the name people see; default: the package name) and `icon` (one of the app's icons, listed below). A Plugin that is built before it is packed says how there too:

```json
{
  "fyflow": {
    "name": "Image tags",
    "icon": "image",
    "build": "pnpm build",
    "pack": "dist"
  }
}
```

`build` is run in the Plugin's folder; `pack` is the folder that is packed, which needs its own `package.json` (the one npm packs). Without them the Plugin's folder is packed as it is. They live in `package.json` rather than in workflow inputs, so each Plugin of a monorepo can say its own.

**Inputs** (all optional):

| Input | What it does |
| --- | --- |
| `platforms` | Empty: one tarball for every platform (the usual case). Else one tarball per group, each packed with `fyflow-plugin pack --platform` on a runner of its platform, and merged into one version's `artifacts`: groups separated by spaces, a group's platforms by commas, e.g. `win32-x64 darwin-arm64,darwin-x64 linux-x64`. A group is one os; it is packed on its first platform's runner. |
| `install` | Your own command to install the repository's dependencies. |
| `node-version` | The Node that builds and packs: default `26`. |
| `tag` | The tag to release, when not run on a tag push. |
| `tools-ref` | The ref of this repository whose scripts the workflow runs: default `v1`, the major you call. |

Pin the major (`@v1`): fixes reach you without changing your workflow, and a breaking change comes as `@v2`.

**Re-running.** If the release fails after the Release was made (a missing secret, say), re-run it: the workflow takes the existing Release when its tarballs are byte for byte what it packed again, and refuses otherwise. To start over before the version is in the index, delete the Release and re-run. Once a version is in the index, it is never released again: bump the version.

### A check on push

`check-plugin.yml` packs each Plugin of your repository with `fyflow-plugin pack` into a temporary folder, as a check that it packs:

```yaml
name: CI
on: [push, pull_request]
jobs:
  pack:
    uses: fyflow/fyflow-plugins/.github/workflows/check-plugin.yml@v1
```

### By hand

1. `npx fyflow-plugin pack --out dist`. It prints the entry: `{ "id", "version", "sdk", "python", "url": "", "integrity" }`.
2. Publish the tarball at an https URL that will not change (a GitHub Release asset is best) and put it in `url`.
3. Fork this repository and add the version to `versions` in `plugins/<id>.json`, without its `id`, and with the `names` its definition declares (below). For a first version, create the file:

```json
{
  "id": "acme.tagger",
  "name": "Tagger",
  "description": "Tags images with a local model.",
  "homepage": "https://github.com/acme/fyflow-plugin-tagger",
  "icon": "tag",
  "versions": [
    {
      "version": "1.0.0",
      "sdk": "^0.10.0",
      "python": false,
      "url": "https://github.com/acme/fyflow-plugin-tagger/releases/download/acme.tagger%401.0.0/fyflow-plugin-tagger-1.0.0.tgz",
      "integrity": "sha512-…",
      "names": { "nodeTypes": ["Tag"], "gateTypes": [] }
    }
  ]
}
```

4. Open a PR. Its checks say what is wrong, if anything.

### Watching the PR's checks

The PR's check named **admit** is the one that must pass. From a terminal:

```sh
gh pr checks <PR URL or number> --repo fyflow/fyflow-plugins --watch
```

A failed check names the file, Plugin, version and rule, as an annotation on the file and in the job's log. Fix it in your Plugin's repository. Then release a new version if the tarball must change; if only the entry was wrong, push a fix to the PR's branch.

## The Plugin files

`plugins/<id>.json` holds a Plugin's fields and its versions, in the shape a Host reads (`index.json`, schema 1, in fyflow-app's `packages/contract/src/repositories.ts`), with three differences:

- **Each version has `names`**: `{ "nodeTypes": [...], "gateTypes": [...] }`, the names its definition declares. CI checks them against the loaded Plugin, and checks them for clashes across Plugins. `index.json` leaves them out.
- **No `published`.** The publish job sets it.
- **Stricter:** URLs are https, and a key the index does not know is refused (a Host would silently ignore a misspelt one).

A version's artifacts take one of two forms, never both:

- `url` and `integrity`, with an optional `platforms` (a non-empty list; absent means every platform);
- `artifacts`: a non-empty list of `{ "platforms", "url", "integrity" }`.

A platform is spelled as Node spells it: `<os>` (`win32`, `darwin`, `linux`: every cpu) or `<os>-<cpu>` (`x64`, `arm64`). No platform may be named twice in one version. Two artifacts may not overlap, as a bare `<os>` in one and an `<os>-<cpu>` of that os in another would.

## What CI checks

On every PR (`.github/workflows/pr.yml`). It runs Plugin code from strangers, so no job has a secret or a token that can write:

1. **Schema.** Each `plugins/*.json` parses and matches the schema above, the Host's rules included: `version` is `x.y.z`, `sdk` is non-empty, `python` is `false` or `{ "variants"?: [...] }`, `integrity` is `sha512-<base64>`, one artifact form, the platform rules, no version listed twice. Its file name is its id. Ids are unique, whatever their case.
2. **Immutability.** A PR may add versions and change a Plugin's own fields (`name`, `description`, `homepage`, `icon`). It may not change or remove a published version: not its `url`, `integrity`, `platforms`, `artifacts`, `sdk`, `python` or `names`. Hosts have installed it by its integrity.
3. **Each new artifact.** Downloaded (https, 256 MB at most, as a Host takes) and refused unless its SHA-512 equals `integrity`, then unpacked as a Host unpacks it (no links, nothing outside the package). Its `package.json` has the entry's `version` and a `fyflow-plugin-sdk` peer range equal to `sdk`. When `python` is not `false`, it holds a Python project with `pyproject.toml` and `uv.lock`. When the package has `dependencies` (and does not bundle them), it holds `npm-shrinkwrap.json`.
4. **Loaded as a Host loads it**, with Node 26, on a runner of each platform the artifact names (Linux for one that runs everywhere; one for a platform no GitHub runner has is checked but not loaded). The published `fyflow-plugin-sdk` is installed in a folder above it, as a Host provides it. Its dependencies are installed with `npm ci --ignore-scripts --omit=dev --omit=peer`. Its entry is imported (`plugin.ts`, else `plugin.js`, else the package's `exports`/`main`) in a process of its own. Its definition's `id` and `version` must equal the entry's, its Node Types and gate types the entry's `names`, and its Python Workers the entry's `python` (and its `python.project` must hold `pyproject.toml` and `uv.lock`). Every artifact of a version is checked against the same `names`, so all of them declare the same Node Types and gate types.
5. **Names are unique across Plugins.** A Node Type or gate type name another Plugin already declares, in any of its versions, is refused. Names are global on a Host (fyflow-app ADR-0029): two Plugins sharing one would bind a shared Flow to the wrong Plugin. A Plugin keeps its own names from version to version.
6. **Warnings, which do not block:** an `sdk` range that admits none of the SDK versions current Hosts implement (0.10.0, 0.9.0, 0.8.0, 0.7.0, 0.6.0, 0.5.0), as no Host would list it; an `icon` the app does not have, as it is not shown; a tarball holding `.venv` or `__pycache__`.
7. **The scripts' own tests** (`npm test`).

On every push to `main` (`.github/workflows/publish.yml`), the publish job builds `index.json` from `plugins/*.json`. It sets each version's `published` to the time of the first commit that added it, from git history, so the build is deterministic and needs no bot commit. It validates the result against the Host's schema once more, and deploys it with a plain `index.html` to GitHub Pages. With no Plugins, the index is `{"schema":1,"plugins":[]}`, which a Host accepts.

### Why the names live in the Plugin files

Rule 5 needs every admitted version's names. They could be computed again from every artifact on each PR, which means downloading and running every Plugin ever admitted, on every PR. Or a publish job could commit them to a generated `names.json`, which means a bot commit and a job that writes to `main`. Instead, each version carries `names` beside its artifacts. The release workflow writes them. The PR check checks them against the loaded Plugin when the version is admitted, and they are immutable from then on. So the check reads them from the files, with no download, no generated file and no bot. They are also in plain sight in the PR's diff.

## Removing a version

A version is not removed by its author: Hosts have it installed, and Flows record it. A maintainer removes one only when it is harmful (malware, a leaked secret, a licence problem). They open a PR that deletes it, or the whole file, and add the **`remove-version`** label, which lets the check accept the removal; editing a version is never accepted. Hosts that installed it keep it. Its version number is never published again under that id with another tarball.

## Plugins with native binaries

Most Plugins are one tarball for every platform. A Plugin that ships binaries of its own has two patterns. The SDK README's [Plugins for some platforms](https://github.com/fyflow/fyflow-app/blob/main/packages/plugin-sdk/README.md#plugins-for-some-platforms) says when to choose which.

- **One artifact per platform.** Each platform's tarball holds that platform's binaries. It is built and packed on that platform's runner with `fyflow-plugin pack --platform <p>`, and the version lists them in `artifacts`. With the release workflow, set `platforms` (`win32-x64 darwin-arm64,darwin-x64 linux-x64`) and it does that. A Host installs the first artifact naming its platform; a Host whose platform none names lists the version as not available. Each tarball is at most 256 MB.
- **Per-platform npm packages.** The binaries go in per-platform npm packages, each with npm's `os`/`cpu`, which the Plugin lists in its `optionalDependencies`, as `sharp` and `esbuild` do. Each Host's npm installs its own, so the Plugin stays one tarball. Install scripts never run on a Host, so the packages must ship their binaries, not build or download them.

A Plugin for only some platforms, as one tarball, sets npm's `os`/`cpu` in its `package.json`: `fyflow-plugin pack` writes them into the entry as `platforms`.

## The app's icons

`activity`, `archive`, `bell`, `bot`, `box`, `braces`, `brain`, `calculator`, `calendar`, `camera`, `chart-bar`, `check`, `clock`, `cloud`, `code`, `cpu`, `credit-card`, `database`, `download`, `file`, `file-text`, `filter`, `flag`, `folder`, `git-branch`, `globe`, `hash`, `image`, `key`, `link`, `list`, `lock`, `mail`, `map-pin`, `message-square`, `package`, `pen-tool`, `play`, `plug`, `repeat`, `search`, `send`, `server`, `settings`, `shield`, `shopping-cart`, `signature`, `sparkles`, `table`, `tag`, `terminal`, `timer`, `trash`, `upload`, `user`, `users`, `wand-sparkles`, `webhook`, `zap`.

## Working on this repository

Node 26 runs the TypeScript scripts directly, with no build step. The only dependency is zod.

```sh
npm ci
npm test                                   # the CI scripts' tests (they install the SDK and npm packages: needs network)
node scripts/check-pr.ts --base origin/main   # the PR check's static part
node scripts/check-artifact.ts --id <id> --version <v> --artifact 0   # one artifact, downloaded and loaded
node scripts/build-index.ts --out _site    # the site the publish job deploys
npx -p typescript -p @types/node tsc -p tsconfig.json   # type check
```

The tests and `check-artifact.ts` install `fyflow-plugin-sdk` from `FYFLOW_PLUGIN_SDK`: an npm spec or a tarball's path, `fyflow-plugin-sdk@^0.10.0` by default. Before an SDK is on npm, point it at the tarball `pnpm sdk:pack` makes in fyflow-app.

| Path | What it is |
| --- | --- |
| `scripts/lib/schema.ts` | The Host's `PluginIndexSchema`, copied from fyflow-app's `packages/contract/src/repositories.ts`, and the stricter schema of the Plugin files. **When the Host's schema, its icons or its SDK versions change, change this copy.** |
| `scripts/lib/sdk-range.ts`, `scripts/lib/tarball.ts` | Copies of the Host's SDK range reader and tarball unpacker, kept alike with theirs. |
| `scripts/lib/repository.ts` | The checks with no download (rules 1, 2, 5, 6) and the load plan. |
| `scripts/lib/artifact.ts`, `scripts/lib/load.ts`, `scripts/lib/load-child.ts` | Rules 3 and 4: one artifact, downloaded, unpacked and loaded. |
| `scripts/check-pr.ts`, `scripts/check-artifact.ts`, `scripts/build-index.ts` | The CLIs the workflows run. |
| `scripts/release/` | The release workflow's steps (`cli.ts plan`, `pack`, `merge`, `apply`, `check`) and `install.sh`. |
| `test/` | The tests, and fixture Plugins that are never published. |

The reusable workflows run this repository's scripts at `tools-ref` (default `v1`). After changing them, move the `v1` tag to the commit (`git tag -f v1 && git push -f origin v1`), or make `v2` for a breaking change.

### Later

- **TODO: a full Host check.** Install each new artifact into a real fyflow Host and run its checks (Workers, schemas, Resource Groups, the SDK range against the versions the Host implements). Today the Host is not published to npm. When it is wanted, a load job can check out `fyflow/fyflow-app` at a tag and use its test Host (`createTestHost` in `packages/testkit`) with `plugins.install: "any"`.
- **Signing the index** is out of scope for now. The index is served over https from GitHub Pages, and each artifact's integrity is pinned in it.
