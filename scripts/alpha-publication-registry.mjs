import { canonical, registry, requireCondition } from './alpha-publication-plan.mjs';

export function mockRegistry(status = { integrity: null, tags: {} }) {
  return async () => structuredClone(status);
}
export function registryReader(fetcher = fetch, now = () => new Date().toISOString()) {
  return async (name, version) => {
    const url = `${registry}/${encodeURIComponent(name)}`;
    const response = await fetcher(url, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    if (response.status === 404) return { integrity: null, tags: {}, readAt: now() };
    requireCondition(response.status === 200, 'Uncertain registry response');
    const metadata = JSON.parse(await boundedText(response, 8 * 1024 * 1024));
    requireCondition(isPlainObject(metadata) && Object.hasOwn(metadata, 'name') && metadata.name === name &&
      Object.hasOwn(metadata, 'versions') && isPlainObject(metadata.versions) &&
      Object.hasOwn(metadata, 'dist-tags') && isPlainObject(metadata['dist-tags']), 'Malformed registry metadata');
    const integrity = Object.hasOwn(metadata.versions, version) ? versionIntegrity(metadata.versions[version], name, version) : null;
    const tags = Object.fromEntries(['alpha', 'latest', 'next'].filter((tag) => Object.hasOwn(metadata['dist-tags'], tag))
      .map((tag) => [tag, metadata['dist-tags'][tag]]));
    requireCondition(Object.values(tags).every((value) => typeof value === 'string'), 'Malformed tags');
    return { integrity, tags, readAt: now() };
  };
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function versionIntegrity(record, name, version) {
  requireCondition(isPlainObject(record) && Object.hasOwn(record, 'name') && record.name === name &&
    Object.hasOwn(record, 'version') && record.version === version && Object.hasOwn(record, 'dist') &&
    isPlainObject(record.dist) && Object.hasOwn(record.dist, 'integrity'), 'Malformed registry version record');
  const integrity = record.dist.integrity;
  requireCondition(typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) &&
    Buffer.from(integrity.slice(7), 'base64').toString('base64') === integrity.slice(7), 'Missing/conflicting registry integrity');
  return integrity;
}
export async function boundedText(response, limit) {
  return (await boundedBytes(response, limit)).toString('utf8');
}
export async function boundedBytes(response, limit) {
  requireCondition(response.body, 'Missing response body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireCondition(size <= limit, 'Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function comparable(status) { return { integrity: status.integrity, tags: status.tags }; }
export function unchanged(before, after) {
  requireCondition(canonical(comparable(before)) === canonical(comparable(after)), 'Registry drift: new plan required');
}
export function classify(status, integrity) {
  if (status.integrity === null) return 'new';
  requireCondition(status.integrity === integrity, 'Immutable version integrity conflict');
  return 'existing';
}
export async function observeUpload(read, item, sleep = async () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = await read(item.name, item.version);
    if (status.integrity !== null) {
      requireCondition(status.integrity === item.integrity, 'Uploaded integrity conflict');
      requireCondition(status.tags.alpha === item.version, 'Unexpected alpha tag after upload');
      requireCondition(status.tags.latest === item.status.tags.latest && status.tags.next === item.status.tags.next, 'latest/next changed');
      return status;
    }
    await sleep();
  }
  throw new Error('Accepted upload visibility unknown; reconcile with NEW plan, never reupload blindly');
}
