import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  FileNotFoundError,
  PathNotFoundError,
  AccessDeniedError,
  NotAuthenticatedError,
  NotEmptyError,
  AuthFailedError,
  BackendError,
} from '@agent-index/filesystem/errors';

/**
 * Amazon S3 backend adapter for the AIFS MCP server.
 *
 * S3 is natively path-based — object keys map directly to logical paths.
 * This makes the adapter the simplest of all backends: no ID resolution,
 * no path cache, no folder-creation ceremony.
 *
 * S3 doesn't have real directories — "folders" are implied by key prefixes.
 * The adapter simulates directory semantics using common prefix listing.
 *
 * Authentication uses the standard AWS credential chain: environment variables,
 * shared credentials file (~/.aws/credentials), SSO, IAM roles, etc.
 * The adapter does not manage credentials itself — it relies on the AWS SDK's
 * built-in credential resolution.
 *
 * Connection config expected in agent-index.json:
 * {
 *   "bucket": "my-org-agent-index",       // S3 bucket name (required)
 *   "region": "us-east-1",                // AWS region (required)
 *   "key_prefix": "",                     // Optional prefix within the bucket
 *   "endpoint": ""                        // Optional custom endpoint (for S3-compatible services)
 * }
 */
export class S3Adapter {
  constructor() {
    this.s3 = null;
    this.sts = null;
    this.connection = null;
  }

  /**
   * Initialize the adapter with connection config and credential store path.
   * Note: S3 uses the AWS credential chain, not the AIFS credential store.
   * The credentialStore parameter is accepted for interface compatibility but unused.
   */
  async initialize(connection, _credentialStore) {
    this.connection = connection;

    if (!connection.bucket) {
      throw new BackendError('S3 connection config missing "bucket"');
    }
    if (!connection.region) {
      throw new BackendError('S3 connection config missing "region"');
    }

    const clientConfig = {
      region: connection.region,
    };

    // Support custom endpoints (MinIO, LocalStack, R2, etc.)
    if (connection.endpoint) {
      clientConfig.endpoint = connection.endpoint;
      clientConfig.forcePathStyle = true;
    }

    this.s3 = new S3Client(clientConfig);
    this.sts = new STSClient(clientConfig);
  }

  // ─── Auth ────────────────────────────────────────────────────────────

  async getAuthStatus() {
    const base = { backend: 's3' };

    try {
      const identity = await this.sts.send(new GetCallerIdentityCommand({}));
      return {
        authenticated: true,
        ...base,
        user_identity: identity.Arn || identity.UserId || 'unknown',
      };
    } catch (err) {
      if (this._isCredentialError(err)) {
        return { authenticated: false, ...base, reason: 'no_credential' };
      }
      if (err.name === 'ExpiredTokenException' || err.name === 'ExpiredToken') {
        return { authenticated: false, ...base, reason: 'expired' };
      }
      return { authenticated: false, ...base, reason: 'invalid' };
    }
  }

  async startAuth() {
    return {
      status: 'awaiting_code',
      auth_url: null,
      message:
        'S3 uses AWS credentials from your environment. To authenticate:\n\n' +
        '**Option 1 — AWS SSO (recommended for orgs):**\n' +
        'Run `aws sso login` in a separate terminal, then confirm here.\n\n' +
        '**Option 2 — Access keys:**\n' +
        'Run `aws configure` in a separate terminal and enter your ' +
        'Access Key ID and Secret Access Key, then confirm here.\n\n' +
        '**Option 3 — Environment variables:**\n' +
        'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your environment.\n\n' +
        'Say "done" when your AWS credentials are configured.',
    };
  }

  async completeAuth(_authCode) {
    // S3 doesn't use auth codes — credentials come from the AWS chain.
    // "Completing" auth just means verifying the credentials work.
    try {
      const identity = await this.sts.send(new GetCallerIdentityCommand({}));

      // Re-initialize S3 client to pick up any new credentials
      const clientConfig = { region: this.connection.region };
      if (this.connection.endpoint) {
        clientConfig.endpoint = this.connection.endpoint;
        clientConfig.forcePathStyle = true;
      }
      this.s3 = new S3Client(clientConfig);

      const arn = identity.Arn || identity.UserId || 'unknown';
      return {
        status: 'authenticated',
        user_identity: arn,
        message: `Successfully authenticated to AWS as ${arn}.`,
      };
    } catch (err) {
      throw new AuthFailedError(
        `AWS credential verification failed: ${err.message}. ` +
        'Make sure you have run `aws configure` or `aws sso login`.'
      );
    }
  }

  // ─── File Operations ─────────────────────────────────────────────────

  async read(path) {
    this._requireAuth();
    const key = this._toKey(path);

    try {
      const res = await this.s3.send(new GetObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
      }));

      const bytes = await res.Body.transformToByteArray();
      const buffer = Buffer.from(bytes);

      // Try UTF-8; fall back to base64 for binary
      const text = buffer.toString('utf-8');
      if (text.includes('\0')) {
        return 'base64:' + buffer.toString('base64');
      }
      return text;
    } catch (err) {
      this._handleS3Error(err, path);
    }
  }

  async write(path, content) {
    this._requireAuth();
    const key = this._toKey(path);

    let body;
    let contentType = 'text/plain; charset=utf-8';
    if (content.startsWith('base64:')) {
      body = Buffer.from(content.slice(7), 'base64');
      contentType = 'application/octet-stream';
    } else {
      body = content;
    }

    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
    } catch (err) {
      this._handleS3Error(err, path);
    }
  }

  async list(path, recursive = false) {
    this._requireAuth();
    const prefix = this._toDirectoryPrefix(path);

    const entries = [];
    let continuationToken;

    do {
      try {
        const params = {
          Bucket: this.connection.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        };

        // Non-recursive: use Delimiter to get "folder" grouping
        if (!recursive) {
          params.Delimiter = '/';
        }

        const res = await this.s3.send(new ListObjectsV2Command(params));

        // Common prefixes are "directories"
        if (res.CommonPrefixes) {
          for (const cp of res.CommonPrefixes) {
            const name = this._prefixToName(cp.Prefix, prefix);
            if (name) {
              entries.push({ name, type: 'directory' });
            }
          }
        }

        // Objects are "files" (skip the directory marker itself)
        if (res.Contents) {
          for (const obj of res.Contents) {
            // Skip the prefix itself (directory marker) and zero-byte folder markers
            if (obj.Key === prefix) continue;

            const name = recursive
              ? obj.Key.slice(prefix.length)
              : obj.Key.slice(prefix.length);

            if (!name || name.endsWith('/')) continue;

            entries.push({
              name,
              type: 'file',
              size: obj.Size || 0,
              modified: obj.LastModified?.toISOString(),
            });
          }
        }

        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } catch (err) {
        this._handleS3Error(err, path);
      }
    } while (continuationToken);

    // If no entries found and we got zero results, check if the "directory" exists
    if (entries.length === 0) {
      // S3 directories are virtual — an empty prefix is still valid.
      // Only throw PathNotFound if the prefix itself has no objects at all.
      const headCheck = await this._prefixHasObjects(prefix);
      if (!headCheck && path !== '/' && path !== '') {
        throw new PathNotFoundError(path);
      }
    }

    return entries;
  }

  async exists(path) {
    this._requireAuth();
    const key = this._toKey(path);

    // Check as file first
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
      }));
      return { exists: true, type: 'file' };
    } catch (err) {
      if (!this._isNotFound(err)) {
        this._handleS3Error(err, path);
      }
    }

    // Check as directory (prefix)
    const prefix = key.endsWith('/') ? key : key + '/';
    if (await this._prefixHasObjects(prefix)) {
      return { exists: true, type: 'directory' };
    }

    return { exists: false };
  }

  async stat(path) {
    this._requireAuth();
    const key = this._toKey(path);

    try {
      const res = await this.s3.send(new HeadObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
      }));

      return {
        size: res.ContentLength || 0,
        modified: res.LastModified?.toISOString(),
        etag: res.ETag,
      };
    } catch (err) {
      this._handleS3Error(err, path);
    }
  }

  async delete(path) {
    this._requireAuth();
    const key = this._toKey(path);

    // Check if it's a "directory" with children
    const prefix = key.endsWith('/') ? key : key + '/';
    const dirCheck = await this._prefixHasObjects(prefix);
    if (dirCheck) {
      // It's a directory — check if it has contents beyond itself
      const res = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.connection.bucket,
        Prefix: prefix,
        MaxKeys: 2,
      }));
      const contents = (res.Contents || []).filter(o => o.Key !== prefix);
      if (contents.length > 0 || (res.CommonPrefixes && res.CommonPrefixes.length > 0)) {
        throw new NotEmptyError(path);
      }
    }

    // Check the file exists first
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
      }));
    } catch (err) {
      if (this._isNotFound(err)) {
        throw new FileNotFoundError(path);
      }
      this._handleS3Error(err, path);
    }

    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.connection.bucket,
        Key: key,
      }));
    } catch (err) {
      this._handleS3Error(err, path);
    }
  }

  async copy(source, destination) {
    this._requireAuth();
    const sourceKey = this._toKey(source);
    const destKey = this._toKey(destination);

    // Verify source exists
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.connection.bucket,
        Key: sourceKey,
      }));
    } catch (err) {
      if (this._isNotFound(err)) {
        throw new FileNotFoundError(source);
      }
      this._handleS3Error(err, source);
    }

    try {
      await this.s3.send(new CopyObjectCommand({
        Bucket: this.connection.bucket,
        CopySource: `${this.connection.bucket}/${sourceKey}`,
        Key: destKey,
      }));
    } catch (err) {
      this._handleS3Error(err, source);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _requireAuth() {
    if (!this.s3) {
      throw new NotAuthenticatedError('no_credential');
    }
  }

  /**
   * Convert a logical AIFS path to an S3 object key.
   * Applies the configured key prefix.
   */
  _toKey(path) {
    const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const prefix = (this.connection.key_prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (prefix) {
      return normalized ? `${prefix}/${normalized}` : prefix;
    }
    return normalized;
  }

  /**
   * Convert a logical AIFS directory path to an S3 prefix (with trailing slash).
   */
  _toDirectoryPrefix(path) {
    const key = this._toKey(path);
    if (!key) return ''; // Root
    return key.endsWith('/') ? key : key + '/';
  }

  /**
   * Extract a directory name from a common prefix relative to the parent prefix.
   */
  _prefixToName(commonPrefix, parentPrefix) {
    const relative = commonPrefix.slice(parentPrefix.length);
    return relative.replace(/\/+$/, '');
  }

  /**
   * Check if any objects exist under a given prefix.
   */
  async _prefixHasObjects(prefix) {
    try {
      const res = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.connection.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      return (res.KeyCount || 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if an error is a "not found" type.
   */
  _isNotFound(err) {
    return (
      err instanceof NoSuchKey ||
      err instanceof NotFound ||
      err.name === 'NoSuchKey' ||
      err.name === 'NotFound' ||
      err.$metadata?.httpStatusCode === 404
    );
  }

  /**
   * Check if an error is a credential/auth error.
   */
  _isCredentialError(err) {
    return (
      err.name === 'CredentialsProviderError' ||
      err.name === 'NoSuchTokenProviderError' ||
      err.message?.includes('Could not load credentials')
    );
  }

  /**
   * Translate S3 errors to AIFS errors.
   */
  _handleS3Error(err, path) {
    if (this._isNotFound(err)) {
      throw new FileNotFoundError(path);
    }

    const status = err.$metadata?.httpStatusCode;

    switch (status) {
      case 401:
      case 403:
        if (this._isCredentialError(err) || err.name === 'ExpiredTokenException') {
          throw new NotAuthenticatedError('expired');
        }
        throw new AccessDeniedError(path);
      default:
        throw new BackendError(
          `S3 error (${err.name || status}): ${err.message}`,
          err
        );
    }
  }
}
