// The `index.json` a fyflow Host reads, schema 1, and the `plugins/<id>.json` files this repository builds it from.
//
// `PluginIndexSchema` and what it is made of are copied from fyflow-app's `packages/contract/src/repositories.ts`
// (the Host's own schema, its source of truth): a Host takes the whole index as malformed when a key it reads is
// wrong, so this must refuse exactly what it refuses. When the Host's schema changes, change this copy with it.
import { z } from "zod";

export const PLUGIN_INDEX_SCHEMA = 1;

/** The app's icon names (fyflow-app `packages/contract/src/icons.ts`). Another is not shown: a warning here. */
export const ICON_NAMES = [
  "activity", "archive", "bell", "bot", "box", "braces", "brain", "calculator", "calendar", "camera", "chart-bar",
  "check", "clock", "cloud", "code", "cpu", "credit-card", "database", "download", "file", "file-text", "filter",
  "flag", "folder", "git-branch", "globe", "hash", "image", "key", "link", "list", "lock", "mail", "map-pin",
  "message-square", "package", "pen-tool", "play", "plug", "repeat", "search", "send", "server", "settings",
  "shield", "shopping-cart", "signature", "sparkles", "table", "tag", "terminal", "timer", "trash", "upload", "user",
  "users", "wand-sparkles", "webhook", "zap",
];

/**
 * The SDK versions current Hosts implement: fyflow-plugin-sdk's `SDK_VERSION` and `SDK_COMPATIBLE`. A version whose
 * `sdk` range admits none of them is listed by no current Host: a warning here.
 */
export const HOST_SDK_VERSIONS = ["0.10.1", "0.10.0", "0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0"];

/** The largest artifact a Host downloads. */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

// ---- Copied from fyflow-app packages/contract/src/repositories.ts ------------------------------------------------

const Integrity = z
  .string()
  .regex(/^sha512-[A-Za-z0-9+/]{86}==$/, "an integrity is sha512-<base64 of 64 bytes>");

const PlatformName = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a platform is <os> or <os>-<cpu>, as Node spells them (linux-x64)");

const Platforms = z.array(PlatformName).min(1);

const TarballUrl = z.url({ protocol: /^https?$/ });

export const PluginIndexArtifactSchema = z.object({
  platforms: Platforms,
  url: TarballUrl,
  integrity: Integrity,
});

const PluginIndexVersionObject = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "a version is x.y.z"),
  sdk: z.string().min(1),
  python: z.union([z.literal(false), z.object({ variants: z.array(z.string().min(1)).optional() })]),
  url: TarballUrl.optional(),
  integrity: Integrity.optional(),
  platforms: Platforms.optional(),
  artifacts: z.array(PluginIndexArtifactSchema).min(1).optional(),
  published: z.iso.datetime({ offset: true }).optional(),
});

type VersionShape = z.infer<typeof PluginIndexVersionObject>;

/** The Host's rules across a version's keys: one artifact form, no platform twice, no overlapping artifacts. */
function versionRules(version: VersionShape, ctx: z.RefinementCtx) {
  if (version.artifacts !== undefined) {
    for (const key of ["url", "integrity", "platforms"] as const)
      if (version[key] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "a version has url and integrity, or artifacts, never both",
        });
  } else
    for (const key of ["url", "integrity"] as const)
      if (version[key] === undefined)
        ctx.addIssue({ code: "custom", path: [key], message: `a version has ${key}, or artifacts` });
  const lists = version.artifacts?.map((a) => a.platforms) ?? [version.platforms ?? []];
  const earlier: { platform: string; at: number }[] = [];
  lists.forEach((platforms, at) => {
    const path = version.artifacts === undefined ? ["platforms"] : ["artifacts", at, "platforms"];
    platforms.forEach((platform, i) => {
      if (platforms.indexOf(platform) !== i || earlier.some((e) => e.platform === platform))
        ctx.addIssue({ code: "custom", path, message: `${version.version} names ${platform} twice` });
      else {
        const overlap = earlier.find((e) => e.at !== at && platformsOverlap(e.platform, platform));
        if (overlap !== undefined)
          ctx.addIssue({
            code: "custom",
            path,
            message: `${version.version} names ${overlap.platform} and ${platform} in two artifacts: a Host on both would match each`,
          });
      }
    });
    for (const platform of platforms) earlier.push({ platform, at });
  });
}

export const PluginIndexVersionSchema = PluginIndexVersionObject.superRefine(versionRules);

const platformsOverlap = (a: string, b: string): boolean =>
  (!a.includes("-") && b.startsWith(`${a}-`)) || (!b.includes("-") && a.startsWith(`${b}-`));

const PluginFields = {
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  homepage: z.url({ protocol: /^https?$/ }).optional(),
  icon: z.string().min(1).optional(),
};

export const PluginIndexEntrySchema = z.object({
  ...PluginFields,
  versions: z.array(PluginIndexVersionSchema).min(1),
});

/** Ids, and versions of one id, listed twice. */
function duplicateRules(plugins: { id: string; versions: { version: string }[] }[], ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  plugins.forEach(({ id, versions }, at) => {
    if (ids.has(id)) ctx.addIssue({ code: "custom", path: ["plugins", at, "id"], message: `${id} is listed twice` });
    ids.add(id);
    const seen = new Set<string>();
    versions.forEach(({ version }, v) => {
      if (seen.has(version))
        ctx.addIssue({
          code: "custom",
          path: ["plugins", at, "versions", v, "version"],
          message: `${id} ${version} is listed twice`,
        });
      seen.add(version);
    });
  });
}

export const PluginIndexSchema = z
  .object({
    schema: z.literal(PLUGIN_INDEX_SCHEMA, { error: `this Host reads index schema ${PLUGIN_INDEX_SCHEMA}` }),
    plugins: z.array(PluginIndexEntrySchema),
  })
  .superRefine(({ plugins }, ctx) => duplicateRules(plugins, ctx));

// ---- End of the copy ----------------------------------------------------------------------------------------------

/** A Node Type or gate type name, as a definition's keys give it. */
const TypeName = z.string().min(1);

/**
 * The names a version's definition declares: its Node Types and gate types. This repository keeps them in each
 * version of `plugins/<id>.json` (the release workflow writes them; CI checks them against the loaded Plugin), so
 * the PR check sees every admitted Plugin's names without downloading anything. `index.json` leaves them out.
 */
export const NamesSchema = z
  .object({
    nodeTypes: z.array(TypeName),
    gateTypes: z.array(TypeName),
  })
  .strict();

/**
 * A version in `plugins/<id>.json`: the index's version, stricter. Its URLs are https; it has the `names` it
 * declares; it has no `published` (the publish job sets that from git history) and no key the index does not know,
 * so a misspelt key is caught here rather than silently ignored by every Host.
 */
export const PluginFileVersionSchema = PluginIndexVersionObject.omit({ published: true })
  .extend({
    url: z.url({ protocol: /^https$/, error: "the official repository takes https URLs only" }).optional(),
    artifacts: z
      .array(
        PluginIndexArtifactSchema.extend({
          url: z.url({ protocol: /^https$/, error: "the official repository takes https URLs only" }),
        }).strict(),
      )
      .min(1)
      .optional(),
    names: NamesSchema,
  })
  .strict()
  .superRefine(versionRules);

/** `plugins/<id>.json`: one Plugin, its fields and its versions. */
export const PluginFileSchema = z
  .object({
    ...PluginFields,
    homepage: z.url({ protocol: /^https$/, error: "the official repository takes https URLs only" }).optional(),
    versions: z.array(PluginFileVersionSchema).min(1),
  })
  .strict()
  .superRefine(({ id, versions }, ctx) => {
    const seen = new Set<string>();
    versions.forEach(({ version }, v) => {
      if (seen.has(version))
        ctx.addIssue({ code: "custom", path: ["versions", v, "version"], message: `${id} ${version} is listed twice` });
      seen.add(version);
    });
  });

export type PluginIndex = z.infer<typeof PluginIndexSchema>;
export type PluginFile = z.infer<typeof PluginFileSchema>;
export type PluginFileVersion = z.infer<typeof PluginFileVersionSchema>;
export type Names = z.infer<typeof NamesSchema>;

/** One artifact of a version, whichever form it is in: `platforms` null for one that runs everywhere. */
export interface Artifact {
  platforms: string[] | null;
  url: string;
  integrity: string;
}

/** A version's artifacts, in the index's order (fyflow-app's `artifactsOf`). */
export function artifactsOf(version: {
  url?: string;
  integrity?: string;
  platforms?: string[];
  artifacts?: { platforms: string[]; url: string; integrity: string }[];
}): Artifact[] {
  if (version.artifacts !== undefined) return version.artifacts.map((a) => ({ ...a }));
  if (version.url === undefined || version.integrity === undefined) return [];
  return [{ platforms: version.platforms ?? null, url: version.url, integrity: version.integrity }];
}

/** A zod error's issues as `path: message` lines, the path as `versions[0].url`. */
export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
      .join("");
    const message =
      issue.code === "unrecognized_keys"
        ? `unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((k) => `"${k}"`).join(", ")}${
            issue.keys.includes("published")
              ? " (the repository sets `published` when it publishes; leave it out)"
              : issue.keys.includes("id")
                ? " (a version has no `id`: the Plugin's id is the file's)"
                : ""
          }`
        : issue.message;
    return path === "" ? message : `${path}: ${message}`;
  });
}
