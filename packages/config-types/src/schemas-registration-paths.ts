import { z } from "zod";

const reserved = new Set(["__proto__", "constructor", "prototype"]);
const reservedPattern = [...reserved].join("|");
export const serviceIdPattern = new RegExp(
  `^(?!(?:${reservedPattern})$)[a-z][a-z0-9-]*$`,
);
export const providerIdPattern = new RegExp(
  `^(?!(?:${reservedPattern})$)[A-Za-z0-9][A-Za-z0-9._-]*$`,
);

export function isReservedPathSegment(segment: string): boolean {
  return reserved.has(segment);
}

export const serviceIdSchema = z.string().regex(serviceIdPattern);
export const providerIdSchema = z.string().regex(providerIdPattern);
export const registrationEnvironmentSchema = z
  .string()
  .min(1)
  .refine((value) => !isReservedPathSegment(value), {
    message: "Environment uses a reserved identifier",
  });
export const publicConfigPathSchema = z
  .string()
  .superRefine((path, context) => {
    const message = publicSlashPathIssue(path);
    if (message !== undefined) context.addIssue({ code: "custom", message });
  });
export const slotPathSchema = z.string().superRefine((path, context) => {
  const message =
    path.length > 1 && path.endsWith("/")
      ? "slotPath must not end with /"
      : publicSlashPathIssue(path);
  if (message !== undefined) context.addIssue({ code: "custom", message });
});

function publicSlashPathIssue(path: string): string | undefined {
  if (!path.startsWith("/")) return "Path must start with /";
  if (path === "/") return "Path must not be root";
  if (path.includes("//")) return "Path must not contain empty segments";
  if (path === "/_weaver" || path.startsWith("/_weaver/"))
    return "Path is reserved for Weaver metadata";
  for (const segment of path.slice(1).split("/")) {
    if (segment.includes("[") || segment.includes("]"))
      return "Path must use canonical slash segments";
    if (isReservedPathSegment(segment))
      return `Path segment "${segment}" is not allowed`;
  }
  return undefined;
}
