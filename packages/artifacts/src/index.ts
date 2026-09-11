import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ArtifactStoreConfig {
  endpoint: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface ArtifactUpload {
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export function artifactObjectKey(
  tenantId: string,
  runId: string,
  artifactId: string,
  name: string,
): string {
  const safeName = name
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'artifact';
  return `tenants/${tenantId}/runs/${runId}/${artifactId}/${safeName}`;
}

export function projectSnapshotObjectKey(tenantId: string, projectId: string) {
  return `tenants/${tenantId}/projects/${projectId}/snapshot-v1.json`;
}

function isMissingBucket(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchBucket' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function client(config: ArtifactStoreConfig, endpoint: string) {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

export class S3ArtifactStore {
  private readonly internalClient: S3Client;
  private readonly signingClient: S3Client;

  constructor(private readonly config: ArtifactStoreConfig) {
    this.internalClient = client(config, config.endpoint);
    this.signingClient = client(
      config,
      config.publicEndpoint ?? config.endpoint,
    );
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.internalClient.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
      );
    }
  }

  async ping(): Promise<void> {
    await this.internalClient.send(
      new HeadBucketCommand({ Bucket: this.config.bucket }),
    );
  }

  async createUpload(
    objectKey: string,
    contentType: string,
    sha256: string,
    expiresInSeconds = 900,
  ): Promise<ArtifactUpload> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
      ContentType: contentType,
      Metadata: { sha256 },
    });
    const uploadUrl = await getSignedUrl(this.signingClient, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type', 'x-amz-meta-sha256']),
      unhoistableHeaders: new Set(['x-amz-meta-sha256']),
    });
    return {
      uploadUrl,
      headers: {
        'content-type': contentType,
        'x-amz-meta-sha256': sha256,
      },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
    };
  }

  async verifyObject(
    objectKey: string,
    expected: { sizeBytes: number; sha256: string },
  ): Promise<void> {
    const object = await this.internalClient
      .send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }))
      .catch((error: unknown) => {
        if (isMissingBucket(error)) {
          throw new ArtifactVerificationError('Artifact object was not uploaded');
        }
        throw error;
      });
    if (object.ContentLength !== expected.sizeBytes) {
      throw new ArtifactVerificationError('Artifact size does not match');
    }
    if (object.Metadata?.sha256 !== expected.sha256) {
      throw new ArtifactVerificationError('Artifact checksum metadata does not match');
    }
  }

  async putObject(
    objectKey: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectBytes(objectKey: string): Promise<Uint8Array> {
    const object = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
    );
    if (!object.Body) throw new Error('Object body is empty');
    return object.Body.transformToByteArray();
  }

  async createDownloadUrl(objectKey: string, expiresInSeconds = 300) {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      { expiresIn: expiresInSeconds },
    );
  }

  destroy() {
    this.internalClient.destroy();
    if (this.signingClient !== this.internalClient) this.signingClient.destroy();
  }
}

export class ArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactVerificationError';
  }
}
