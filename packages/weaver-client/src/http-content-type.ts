const jsonMediaType = "application/json";
const tokenCharacterPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;
const quotedTextPattern = /^[\t !#-[\]-~]$/;
const quotedPairPattern = /^[\t !-~]$/;

export function isJsonContentType(contentType: string): boolean {
  let index = skipOws(contentType, 0);
  const mediaType = contentType.slice(index, index + jsonMediaType.length);
  if (mediaType.toLowerCase() !== jsonMediaType) return false;
  index = skipOws(contentType, index + jsonMediaType.length);
  while (index < contentType.length) {
    if (contentType[index] !== ";") return false;
    index = skipOws(contentType, index + 1);
    const nameStart = index;
    while (tokenCharacterPattern.test(contentType[index] ?? "")) index++;
    if (index === nameStart) return false;
    index = skipOws(contentType, index);
    if (contentType[index] !== "=") return false;
    index = skipOws(contentType, index + 1);
    if (contentType[index] === '"') {
      index = scanQuotedString(contentType, index + 1);
      if (index < 0) return false;
    } else {
      const valueStart = index;
      while (tokenCharacterPattern.test(contentType[index] ?? "")) index++;
      if (index === valueStart) return false;
    }
    index = skipOws(contentType, index);
  }
  return true;
}

function skipOws(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index++;
  return index;
}

function scanQuotedString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      index++;
      if (!quotedPairPattern.test(value[index] ?? "")) return -1;
    } else if (!quotedTextPattern.test(value[index] ?? "")) return -1;
    index++;
  }
  return -1;
}
