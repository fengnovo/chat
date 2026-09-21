export type RateLimitScope = { key: string; limit: number };

type Identity = { tenantId: string; userId: string };

type Limits = {
  RATE_LIMIT_REQUESTS: number;
  KNOWLEDGE_UPLOAD_RATE_LIMIT_REQUESTS: number;
};

/**
 * 知识库摄取路径：单文件预签名、上传确认，以及整目录导入期间被高频调用的列表接口
 * （`GET /documents`、`GET /assets`）。前端按「预签名 → PUT 对象存储 → 确认」逐文件推进，
 * 每一个上传完成后还会立即刷新一次文档列表，整目录导入会在几十秒内产生上千次请求，
 * 因此这些路径统一走更宽松的摄取桶，不挤占交互式 API 配额。
 *
 * 单条资产 / 单条文档的细粒度查询、切片列表、检索问答仍走默认交互桶。
 */
const KNOWLEDGE_UPLOAD_PATH =
  /^\/api\/knowledge-bases\/[^/]+\/(?:documents\/uploads|documents\/[^/]+\/confirm|assets\/[^/]+\/confirm|documents|assets)$/;

/** 该路径是否为知识库上传预签名 / 确认请求。 */
export function isKnowledgeUploadPath(pathname: string): boolean {
  return KNOWLEDGE_UPLOAD_PATH.test(pathname);
}

/** 按请求路径选择限流桶：摄取流量走独立且更宽松的桶，其余仍用默认桶。 */
export function resolveRateLimit(pathname: string, identity: Identity, limits: Limits): RateLimitScope {
  if (isKnowledgeUploadPath(pathname)) {
    return {
      key: `rate:knowledge-upload:${identity.tenantId}:${identity.userId}`,
      limit: limits.KNOWLEDGE_UPLOAD_RATE_LIMIT_REQUESTS,
    };
  }
  return {
    key: `rate:api:${identity.tenantId}:${identity.userId}`,
    limit: limits.RATE_LIMIT_REQUESTS,
  };
}
