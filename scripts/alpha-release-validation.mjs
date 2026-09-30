// Evidence-only policy checks; this module never executes a package manager.
const minorPackages = new Set([
  'config-types', 'config-engine', 'transport-scomp', 'weaver-client', 'weaver-server',
]);

export const expectedVersions = Object.freeze(Object.fromEntries([
  ...[...minorPackages].map((name) => [name, '0.2.0-alpha.0']),
  ...[
    'config-auth', 'config-policy', 'config-runtime', 'config-secrets',
    'config-sessions', 'config-sync', 'storage-provider-local-storage',
    'storage-provider-static-json', 'storage-providers', 'demo',
  ].map((name) => [name, '0.1.3-alpha.0']),
  ['playground', '0.1.5-alpha.0'],
].map(([name, version]) => [`@weaver-conf/${name}`, version])));

export function validateAlphaSelection(manifests, tag) {
  if (tag !== 'alpha') throw new Error('Only the alpha dist-tag is permitted');
  const names = new Set();
  for (const manifest of manifests) {
    if (!Object.hasOwn(expectedVersions, manifest.name) || manifest.private !== false ||
      ['@weaver-conf/demo', '@weaver-conf/playground'].includes(manifest.name)) {
      throw new Error('Only allowlisted public packages may be selected');
    }
    if (!/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-alpha\.(?:0|[1-9]\d*)$/.test(manifest.version)) {
      throw new Error('Expected a pre-1 alpha version');
    }
    if (names.has(manifest.name)) throw new Error('Duplicate package selection');
    names.add(manifest.name);
  }
  if (names.size === 0) throw new Error('Empty package selection');
}

export function validatePackedDependencies(manifest, versions) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || /(?:workspace|link|file):/.test(spec)) {
        throw new Error(`Unresolved packed dependency: ${name}`);
      }
      if (Object.hasOwn(versions, name) && spec !== versions[name]) {
        throw new Error(`Incoherent prerelease dependency: ${name}`);
      }
    }
  }
}

export function validatePublicationIntent(manifests, executable, args) {
  if (executable !== 'pnpm' || args[0] !== 'publish') {
    throw new Error('Not an explicit package-manager publication intent');
  }
  const tagFlags = args.filter((arg) => arg === '--tag' || arg.startsWith('--tag='));
  if (tagFlags.length !== 1 || !args.includes('--tag') || args[args.indexOf('--tag') + 1] !== 'alpha') {
    throw new Error('An explicit single --tag alpha is required');
  }
  if (args.some((arg) => ['-r', '--recursive', '--filter'].includes(arg) || arg.startsWith('--filter='))) {
    throw new Error('Broad workspace publication is not permitted');
  }
  validateAlphaSelection(manifests, 'alpha');
}
