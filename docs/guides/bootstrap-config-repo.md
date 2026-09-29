# Bootstrap Config Repository

Weaver can bootstrap server storage providers from one Git repository. At startup,
`startWeaverServer({ repoUrl, gitToken, environment })` clones or pulls that repo,
reads `bootstrap/server.json`, and creates the configured layers.

This guide documents the current implementation only. Future models for
git-tree providers, multiple sources, and tenant-owned repositories are described
in [ADR 0004](../adr/0004-future-hybrid-git-source-model.md).

## Current scope and non-goals

Supported today:

- One Git repository source, configured by `repoUrl` or `WEAVER_CONFIG_REPO`.
- A required `bootstrap/server.json` file in that repository.
- Bootstrap provider types: `git`, `mongodb`, and `memory`.
- Git-backed layers store one JSON file per layer, selected by each layer's
  `path` field.

Not implemented today:

- No current `git-tree` provider.
- No current multi-source or tenant-repository bootstrap model.
- No schema-based path sharding yet.

## Example repository layout

```text
weaver-config/
  bootstrap/
    server.json
  layers/
    platform.json
    tenant-defaults.json
```

## Example `bootstrap/server.json`

```json
{
  "layers": [
    {
      "id": "platform",
      "provider": "git",
      "path": "layers/platform.json"
    },
    {
      "id": "tenant:default",
      "provider": "git",
      "path": "layers/tenant-defaults.json"
    },
    {
      "id": "user",
      "provider": "mongodb"
    },
    {
      "id": "session",
      "provider": "memory"
    }
  ],
  "mongodb": {
    "uri": "${WEAVER_MONGO_URI}"
  }
}
```

`mongodb.uri` is required when any layer uses the `mongodb` provider. Environment
variables in bootstrap JSON are resolved at startup.

## Example layer JSON files

`layers/platform.json`:

```json
{
  "services": {
    "billing": {
      "currency": "USD",
      "retryMax": 3
    }
  }
}
```

`layers/tenant-defaults.json`:

```json
{
  "services": {
    "billing": {
      "currency": "EUR"
    }
  }
}
```

## Starting from bootstrap

Pass bootstrap inputs directly:

```ts
import { startWeaverServer } from "@weaver-conf/weaver-server";

await startWeaverServer({
  repoUrl: "https://github.com/acme/weaver-config.git",
  gitToken: process.env.WEAVER_GIT_TOKEN,
  environment: "production",
});
```

Or use environment variables:

```env
WEAVER_CONFIG_REPO=https://github.com/acme/weaver-config.git
WEAVER_GIT_TOKEN=github_pat_xxxxxxxxxxxx
WEAVER_ENVIRONMENT=production
WEAVER_MONGO_URI=mongodb://mongo.example.com:27017/weaver
```

If `providers` are passed directly to `startWeaverServer()`, bootstrap is skipped.
If neither providers nor a repo URL are provided, the server starts with an
in-memory `platform` layer.

Before seeding application values or replacing an existing server, follow the
[schema-required write rollout](schema-required-rollout.md): the authoritative
registry must be bound and schemas registered before public seed writes.

## GitHub authentication

Use an HTTPS GitHub URL in `WEAVER_CONFIG_REPO` and put credentials in
`WEAVER_GIT_TOKEN`. Do not embed the token in the repository URL.

The token needs repository contents read access for clone and pull. If the server
will persist writes to Git-backed layers, it also needs contents write access.
Either a fine-grained personal access token or an already-minted GitHub App
installation token is acceptable.

The current server does not mint or refresh GitHub App installation tokens.
Deployment runtimes should provide the token from a secret manager or environment
variable, rotate it regularly, scope it to the target repo, and grant the least
privilege needed for the deployment.

SSH deploy keys may work when the runtime Git environment is configured for SSH,
but the documented and supported bootstrap path is HTTPS plus `WEAVER_GIT_TOKEN`.
