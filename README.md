# agent-index-filesystem-s3

Amazon S3 adapter for the agent-index remote filesystem. Connects the `aifs_*` MCP tool interface to S3 object storage via the AWS SDK.

## Overview

This adapter implements the `BackendAdapter` interface from `@agent-index/filesystem` against the AWS S3 API. S3 uses native object key paths, so path resolution is direct — no ID mapping or caching needed. Supports IAM credentials, AWS SSO, and S3-compatible services (MinIO, Cloudflare R2, DigitalOcean Spaces).

Members never interact with this package directly. The pre-built bundle is included in the bootstrap zip during org setup and runs as a background MCP server process inside Cowork.

## Features

- Standard S3 and S3-compatible service support
- IAM credentials and AWS SSO authentication
- Key prefix support for shared buckets
- Native object key path access (no ID resolution needed)
- All 9 `aifs_*` tools supported

## Connection Config

Set by the org admin during `create-org`:

| Field | Required | Description |
|---|---|---|
| `bucket` | Yes | S3 bucket name. |
| `region` | Yes | AWS region (e.g., `us-east-1`). |
| `prefix` | No | Key prefix for all paths. Omit or empty string for bucket root. |

## Development

```bash
npm install              # Install dependencies
npm run build            # Bundle, checksum, and stamp adapter.json
npm run build:bundle     # esbuild only (no metadata stamp)
npm test                 # Run tests
```

The `npm run build` command produces `dist/server.bundle.js` (a self-contained single-file MCP server) and updates `adapter.json` with the build timestamp and checksum. Commit both files together.

## Repository Structure

```
├── adapter.json            # Adapter metadata, connection schema, build info
├── package.json            # Source dependencies and build scripts
├── scripts/
│   └── build.js            # Build pipeline (bundle + checksum + stamp)
├── src/
│   ├── index.js            # Entry point
│   └── adapters/
│       └── s3.js           # BackendAdapter implementation
└── dist/
    └── server.bundle.js    # Pre-built bundle (committed to repo)
```

## License

Proprietary — Copyright (c) 2026 Agent Index Inc. All rights reserved. See [LICENSE](LICENSE) for details.
