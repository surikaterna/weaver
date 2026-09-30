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
    requireCondition(metadata.name === name && metadata.versions && typeof metadata.versions === 'object' && !Array.isArray(metadata.versions) &&
      metadata['dist-tags'] && typeof metadata['dist-tags'] === 'object' && !Array.isArray(metadata['dist-tags']), 'Malformed registry metadata');
    const record = metadata.versions[version];
    const integrity = record ? record.dist?.integrity : null;
    requireCondition(!record || (record.name === name && record.version === version && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)), 'Missing/conflicting registry integrity');
    const tags = Object.fromEntries(['alpha', 'latest', 'next'].filter((tag) => Object.hasOwn(metadata['dist-tags'], tag))
      .map((tag) => [tag, metadata['dist-tags'][tag]]));
    requireCondition(Object.values(tags).every((value) => typeof value === 'string'), 'Malformed tags');
    return { integrity, tags, readAt: now() };
  };
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
