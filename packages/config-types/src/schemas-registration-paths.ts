import { z } from "zod";

export const serviceIdPattern =
  /^(?!(?:__proto__|constructor|prototype)$)[a-z][a-z0-9-]*$/;
export const providerIdPattern =
  /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

const unsafePathSegments = new Set(["__proto__", "constructor", "prototype"]);

export const serviceIdSchema = z.string().regex(serviceIdPattern);
export const providerIdSchema = z.string().regex(providerIdPattern);
export const publicConfigPathSchema = z
  .string()
  .superRefine((path, context) => {
    const message = validatePublicSlashPath(path);
    if (message !== undefined) context.addIssue({ code: "custom", message });
  });
export const slotPathSchema = z.string().superRefine((path, context) => {
  if (path.length > 1 && path.endsWith("/")) {
    context.addIssue({
      code: "custom",
      message: "slotPath must not end with /",
    });
    return;
  }
  const message = validatePublicSlashPath(path);
  if (message !== undefined) context.addIssue({ code: "custom", message });
});

function validatePublicSlashPath(path: string): string | undefined {
  if (!path.startsWith("/")) return "Path must start with /";
  if (path === "/") return "Path must not be root";
  if (path.includes("//")) return "Path must not contain empty segments";
  if (path === "/_weaver" || path.startsWith("/_weaver/")) {
    return "Path is reserved for Weaver metadata";
  }

  for (const segment of path.slice(1).split("/").filter(Boolean)) {
    if (segment.includes("[") || segment.includes("]")) {
      return "Path must use canonical slash segments";
    }
    if (unsafePathSegments.has(segment)) {
      return `Path segment "${segment}" is not allowed`;
    }
  }
  return undefined;
}
