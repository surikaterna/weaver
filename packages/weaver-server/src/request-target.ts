const pcharPattern = /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/;
const percentTripletPattern = /%[0-9A-Fa-f]{2}/;
const controlPattern = /\p{Cc}/u;
const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"]);

export type ParsedRequestTarget =
  | {
      readonly success: true;
      readonly pathname: string;
      readonly query: Record<string, string>;
      readonly url: URL;
    }
  | { readonly success: false };

export function parseRequestTarget(
  requestTarget: string,
  baseUrl: string,
): ParsedRequestTarget {
  const pathname = canonicalPathname(requestTarget);
  if (pathname === null) return { success: false };

  let url: URL;
  try {
    url = new URL(requestTarget, baseUrl);
  } catch {
    return { success: false };
  }
  const query = uniqueQuery(url.searchParams);
  if (isV1Path(pathname) && query === null) return { success: false };
  return { success: true, pathname, query: query ?? {}, url };
}

function canonicalPathname(requestTarget: string): string | null {
  if (!requestTarget.startsWith("/")) return null;
  const queryIndex = requestTarget.indexOf("?");
  const rawPath = requestTarget.slice(
    0,
    queryIndex === -1 ? requestTarget.length : queryIndex,
  );
  const decodedSegments: string[] = [];
  for (const rawSegment of rawPath.split("/")) {
    const decoded = decodeCanonicalSegment(rawSegment);
    if (decoded === null) return null;
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/");
}

function decodeCanonicalSegment(rawSegment: string): string | null {
  if (!hasCanonicalTriplets(rawSegment)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  if (decoded.includes("/") || decoded.includes("\\")) return null;
  if (controlPattern.test(decoded)) return null;
  if (forbiddenSegments.has(decoded)) return null;
  if (percentTripletPattern.test(decoded)) return null;
  return encodeCanonicalSegment(decoded) === rawSegment ? decoded : null;
}

function hasCanonicalTriplets(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    const triplet = value.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/.test(triplet)) return false;
    index += 2;
  }
  return true;
}

function encodeCanonicalSegment(segment: string): string {
  let encoded = "";
  for (const character of segment) {
    if (pcharPattern.test(character)) {
      encoded += character;
      continue;
    }
    encoded += [...new TextEncoder().encode(character)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("");
  }
  return encoded;
}

function uniqueQuery(
  searchParams: URLSearchParams,
): Record<string, string> | null {
  const entries: Array<[string, string]> = [];
  const keys = new Set<string>();
  for (const entry of searchParams.entries()) {
    if (keys.has(entry[0])) return null;
    keys.add(entry[0]);
    entries.push(entry);
  }
  return Object.fromEntries(entries);
}

function isV1Path(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}
