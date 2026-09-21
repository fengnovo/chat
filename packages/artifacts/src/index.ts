import {
  CreateBucketCommand,
  DeleteObjectCommand,
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

/**
 * 用户聊天附件的对象键。发送前 run 尚不存在，因此按「租户/用户」暂存，
 * run 创建后只在数据库里关联 run_id，对象本身不移动。
 */
export function chatAttachmentObjectKey(
  tenantId: string,
  userId: string,
  attachmentId: string,
  filename: string,
): string {
  const safeName = filename
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._一-龥-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'attachment';
  return `tenants/${tenantId}/users/${userId}/chat-attachments/${attachmentId}/${safeName}`;
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

  /**
   * 仅下载对象头部若干字节。S3 支持 Range GET，签名上传端下行带宽开销可忽略。
   * 用于在 confirm 阶段按 MIME 校验图片魔数，避免把整张图拉回来。
   */
  async getObjectHead(objectKey: string, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 1) throw new Error('Invalid head length');
    const object = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Range: `bytes=0-${length - 1}`,
      }),
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

  /** 删除单个对象存储文件；对象不存在时静默成功（幂等）。 */
  async deleteObject(objectKey: string): Promise<void> {
    await this.internalClient
      .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }))
      .catch((error: unknown) => {
        if (!isMissingBucket(error)) throw error;
      });
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

/**
 * 图片魔数表。键为归一化后的 MIME（小写），值为前 N 字节的判定函数。
 * 任何新增到 knowledge-routes.ts 的 assetMime 类型必须在这里有对应项，否则 confirm 阶段会拒绝。
 */
const MIN_IMAGE_HEAD_BYTES = 12;

const IMAGE_MAGIC: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/png': (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) =>
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x39 || b[4] === 0x37) && b[5] === 0x61,
  'image/webp': (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

/**
 * 按声明的 MIME 校验字节前缀。专门用来挡住 git-lfs pointer 等
 * 「有合法 MIME 头但其实不是图片」的占位文件，避免污染 caption 队列。
 * 失败时抛 ArtifactVerificationError，沿用既有 400 处理链。
 */
export function assertImageMagic(bytes: Uint8Array, declaredMime: string): void {
  if (bytes.byteLength < MIN_IMAGE_HEAD_BYTES) {
    throw new ArtifactVerificationError(
      `Image payload too small to validate (${bytes.byteLength} bytes, need at least ${MIN_IMAGE_HEAD_BYTES})`,
    );
  }
  const check = IMAGE_MAGIC[declaredMime.toLowerCase()];
  if (!check) {
    throw new ArtifactVerificationError(`Unsupported image MIME: ${declaredMime}`);
  }
  if (!check(bytes)) {
    throw new ArtifactVerificationError(
      `Uploaded bytes do not match declared MIME ${declaredMime}`,
    );
  }
}
