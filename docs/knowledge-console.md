# 知识库控制台（五页签）

## 1. 概述

知识库控制台是面向运营/开发者的知识库管理与验证界面，入口为 `/knowledge`。界面分为顶部四步引导条、左侧导航、右侧内容区三部分，左侧底部固定展示当前选中知识库的摘要。

五个页签：

| 页签 | 功能 |
|---|---|
| 知识库 | 卡片列表，增删改查知识库 |
| 文档管理 | 上传文档（Markdown/TXT）、重命名、删除、查看切片 |
| 切片管理 | 按文档查看切片，搜索、网格/列表视图切换（只读） |
| 知识检索 | 调整 topK/相似度阈值，预览命中切片与真实相似度 |
| 知识问答 | 基于知识库的问答验证，右侧展示引用来源 |

## 2. 页面交互

### 2.1 知识库

- 卡片展示：图标 + 名称 + 描述，统计行（知识库类型 / 文档数量 / 切片数量），页脚更新时间。
- 顶部「+ 创建知识库」+「共 N 个知识库」+ 右侧名称搜索框。
- 编辑：修改名称、描述（可清空）、可见范围（private / tenant）。
- 删除：弹窗需勾选「我已知晓该操作不可恢复」后确认按钮才可用。
- 权限：非 owner/admin 不显示编辑/删除按钮。

### 2.2 文档管理

- 「上传文档」按钮，支持多文件，仅 `.md`/`.markdown`/`.txt`（MIME `text/markdown` / `text/plain`）。
- 每知识库同时只允许一个上传任务。
- 表格列：文档名称/ID、状态 badge、处理策略、切片数、导入方式、更新时间、操作。
- 状态轮询：pending / queued / indexing / processing 时每 4 秒刷新，ready/failed 后停止。
- 状态文案：处理完成 / 处理失败 / 待处理 / 排队中 / 处理中。
- 切片详情：仅 ready 文档可点击，跳转切片管理页。
- 删除：行内二次确认「确认删除？」。

### 2.3 切片管理

- 顶部「共 N 切片」+ 文档下拉筛选 + 切片 ID/内容搜索（300ms debounce）+ 网格/列表视图切换。
- 卡片：`#序号`、chunkId、正文预览、页脚（文档名 / 字符数 / 更新时间）。
- 纯查看，不提供新增/删除。

### 2.4 知识检索

- 左侧参数面板：结果返回数量滑杆（1-20）、最低相似度滑杆（0-1，step 0.01）、重排模型开关（灰显禁用）、Dense Weight（0.50，灰显禁用）。
- 顶部搜索框 + 检索历史 chips（localStorage 存 10 条，按知识库隔离）。
- 结果卡片：真实相似度 badge（Qdrant score，6 位小数）、文档名、召回方式徽章（向量 / 向量+图谱）、正文关键词高亮。
- 顶部统计：命中数 / 耗时 ms / 向量召回数 / 图谱跳数。

### 2.5 知识问答

- 左侧：模型回答参数面板（同检索参数，灰显）+ 服务调用面板（两个 disabled 按钮，占位）。
- 中间：聊天窗，助手问候语随知识库名称变化；输入框 8000 字上限，Enter 发送（IME 组合中不触发）。
- 右侧：固定「引用来源」面板，展示当前回答命中的切片（文档名、分数、召回方式）。
- 答案中引用以 `[n]` 标注，与右侧来源一一对应。

## 3. 后端 API

所有接口需登录态，按租户 + 知识库权限隔离。

### 知识库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/knowledge-bases` | 列表（含 documentCount / chunkCount） |
| POST | `/api/knowledge-bases` | 创建（name, description?, visibility?） |
| GET | `/api/knowledge-bases/:kbId` | 详情 |
| PATCH | `/api/knowledge-bases/:kbId` | 更新（name?, description? 可传 null 清空, visibility?） |
| DELETE | `/api/knowledge-bases/:kbId` | 删除 |

### 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/knowledge-bases/:kbId/documents` | 文档列表 |
| GET | `/api/knowledge-bases/:kbId/documents/:documentId` | 详情 |
| PATCH | `/api/knowledge-bases/:kbId/documents/:documentId` | 重命名（name） |
| DELETE | `/api/knowledge-bases/:kbId/documents/:documentId` | 删除 |
| GET | `/api/knowledge-bases/:kbId/documents/:documentId/chunks` | 切片列表（q, limit≤200, offset） |
| POST | `/api/knowledge-bases/:kbId/documents/uploads` | 预签名上传（返回 presignedUrl + document） |
| POST | `/api/knowledge-bases/:kbId/documents/:documentId/confirm` | 确认上传并入队索引 |

### 检索与问答

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/knowledge-bases/:kbId/retrieval` | 检索（query, topK 1-50, minScore -1~1） |
| POST | `/api/knowledge-bases/:kbId/ask` | 问答（question, topK, minScore） |

- `retrieval` / `ask` 在 knowledge-service（MCP）未配置时返回 `503 knowledge_service_unavailable`。
- `ask` 在问答模型未配置时返回 `503 knowledge_qa_unavailable`。
- `minScore` 由客户端按 Qdrant 真实 score 过滤。

## 4. 检索与问答数据流

```
前端 retrieval/ask
    ↓ HTTP
API (apps/api/src/knowledge-routes.ts)
    ↓ searchKnowledge() / answerWithCitations()
    ↓ 签发 run token (HS256, aud=knowledge-service, 5min)
knowledge-service MCP (Streamable HTTP)
    ├─ POST /mcp initialize → mcp-session-id
    └─ POST /mcp tools/call graphrag_search
          arguments: { query, topK?, includePassage: true }
    ↓
packages/knowledge-graphrag (embedder + qdrant + graph traversal)
```

- **检索**：API 不持有 embedding/Qdrant 凭证，全部代理到 knowledge-service 的 MCP `graphrag_search` 工具。返回 `{ retrievalId, citations, relations, stats }`。
- **问答**：API 先调用检索拿到 citations（passage），再直接调 OpenAI 兼容的 `/chat/completions` 生成答案。System prompt 强制：仅基于资料回答、用 `[n]` 标注引用、资料不足时回复「根据当前知识库无法回答」。
- **相似度**：前端展示的相似度分数来自 Qdrant 真实 cosine score，不做伪造或归一化。

## 5. 权限模型

| 操作 | 权限条件 |
|---|---|
| 查看知识库列表 / 详情 | 可读（owner 或 tenant 可见或被授权或 admin） |
| 创建知识库 | admin 或 owner |
| 编辑 / 删除知识库 | owner 或 admin |
| 修改 visibility | owner 本人或 admin |
| 上传 / 删除 / 重命名文档 | owner 或 admin |
| 查看切片 / 检索 / 问答 | 可读 |

- `readable` = `visibility='tenant' OR owner_user_id=current OR grant EXISTS OR admin`
- `writable` = `owner_user_id=current OR admin`
- 跨租户访问统一返回 404。

## 6. 配置项

### API 侧

| 环境变量 | 说明 |
|---|---|
| `KNOWLEDGE_MCP_URL` | knowledge-service MCP 地址 |
| `KNOWLEDGE_MCP_SECRET` | MCP 鉴权 secret（回退 `KNOWLEDGE_TOKEN_SECRET`） |
| `KNOWLEDGE_MCP_TIMEOUT_MS` | MCP 超时（默认 15000） |
| `OPENAI_BASE_URL` | 问答模型 base URL |
| `OPENAI_API_KEY` | 问答模型 API Key |
| `MODEL` | 问答模型名（默认 `deepseek-chat`） |

### knowledge-service 侧

| 环境变量 | 说明 |
|---|---|
| `EMBEDDING_PROVIDER` | openai / bailian / openai-compatible |
| `EMBEDDING_MODEL` | embedding 模型名 |
| `EMBEDDING_API_KEY` | embedding API Key |
| `EMBEDDING_BASE_URL` | embedding base URL |
| `EMBEDDING_DIM` | 向量维度 |
| `EMBEDDING_PROFILE` | embedding 配置 profile |

## 7. 前端文件结构

```
apps/web/app/knowledge/
├── knowledge-console.tsx   # 五页签主框架、导航、步骤条、当前 KB 摘要
├── knowledge-manager.tsx   # re-export 壳（供 page.tsx 引入）
├── knowledge-api.ts        # API 客户端（snake_case → camelCase）
├── knowledge-helpers.ts    # 纯函数：状态文案、上传预约、时间格式化
├── knowledge-ui.tsx        # 图标、Badge、Modal、检索参数面板
├── kb-view.tsx             # 知识库列表 + 卡片 + 编辑器
├── documents-view.tsx      # 文档表格 + 上传 + 重命名 + 删除
├── chunks-view.tsx         # 切片网格/列表
├── retrieval-view.tsx      # 检索页
└── qa-view.tsx             # 问答页
```

样式统一在 `apps/web/app/styles/knowledge.css`，`.kc-*` 命名空间，通过 `globals.css` 引入。

---

## 8. 为什么没有使用 LlamaIndex

### 8.1 现状：RAG/GraphRAG 全链路自研

在 `packages/knowledge-graphrag` 中已完整实现 RAG 与 GraphRAG 的全链路，运行时代码对 LlamaIndex 零引用：

| 能力 | 自研实现 | LlamaIndex 对应物 |
|---|---|---|
| Embedding | `OpenAICompatibleEmbedder`（直接 fetch `/embeddings`，实例注入） | `OpenAIEmbedding`（全局 `Settings`） |
| 解析 | `parseTextDocument`（Markdown/TXT） | `MarkdownReader` |
| 切片 | `splitIntoChunks` + `stableChunkId`（SHA-256 确定性 ID） | `SentenceSplitter` |
| 向量存储 | `QdrantChunkStore`（按 tenantId 隔离） | `QdrantVectorStore` |
| 图谱 | `InMemoryGraphStore` + `PostgresGraphStore`（key 规范化、关系 ID、双向 BFS） | TS 版无成熟 GraphRAG，仅有基础 `PropertyGraphIndex` |
| 检索 | `mergeCandidates`（向量命中 + 图谱证据按 chunkId 去重、hop 衰减排序） | `VectorIndexRetriever`，图谱检索需自行拼接 |

历史上 `package.json` 曾残留 `llamaindex` / `@llamaindex/*` 死依赖（声明但未被 import），已于清理任务中移除。

### 8.2 三个核心原因

**1. GraphRAG 是刚需，但 LlamaIndex TS 的 GraphRAG 支持薄弱**

完整的 `graph_rag` 模块只在 Python 版存在，LlamaIndex TS 没有开箱即用的图谱抽取 + 多跳检索。如果引入 LlamaIndex TS，GraphRAG 部分仍然需要自行实现，等于用了框架却没享受到其核心价值。

**2. 多租户隔离要求实例化，LlamaIndex 默认是全局单例**

本项目知识库按 `tenant_id` 强隔离，Postgres/Qdrant 均需按租户路由。LlamaIndex 的 `Settings.embedModel` / `Settings.llm` 是全局副作用式的，多租户场景下每个请求动态切换要么加锁、要么每次重建实例，需要绕一大圈。设计文档明确要求「禁止全局 Settings 副作用，模型由实例注入」。

**3. 核心算法已从参考实现迁移完成**

图谱的 key 规范化、关系 ID 合并、双向 BFS 等核心逻辑已从外部 LlamaIndex TS 参考实现迁移为纯函数 + `GraphStore` 接口，不再绑定框架。

### 8.3 改用 LlamaIndex 的改造量评估

**向量检索部分（中等）**：约 5-8 个文件，核心是接口适配——`Embedder` → `OpenAIEmbedding`（需处理多租户动态实例化）、`splitIntoChunks` → `SentenceSplitter`（`stableChunkId` 仍需保留，LlamaIndex 的 node id 非确定性）、`QdrantChunkStore` → `QdrantVectorStore`（租户 filter 需自行添加）。

**GraphRAG 部分（很大）**：约 10-15 个文件。TS 版无现成 GraphRAG 流水线，图谱抽取（LLM 抽实体关系）、双向 BFS、证据合并均需自行编写，与现有实现工作量相当。若改用 Python sidecar 调用 `llama-index-graphrag`，则整体架构需变更（新增 Python 服务）。

**总改造量**：约 15-25 个文件，核心算法包几乎需重写，而 GraphRAG 部分即使引入框架也仍需自研。投入产出比很低。

### 8.4 不用 vs 用的对比

| 维度 | 现状（自研） | 改用 LlamaIndex |
|---|---|---|
| 向量检索 | 自行维护 embedding/切片/存储，代码量中等 | 减少部分代码，生态成熟 |
| GraphRAG | 完全自研，行为可控 | TS 版无现成实现，仍需自研 |
| 多租户 | 实例注入，天然干净 | 需绕开全局 `Settings`，复杂 |
| 依赖体积 | 轻（pg、qdrant-client、zod） | 重（llamaindex 0.10 拖带多个 deprecated 的 `@llamaindex/workflow-*`） |
| 版本风险 | 低，自有代码 | 高，LlamaIndex TS API 变动频繁 |
| 维护成本 | 自行维护 RAG 代码 | 跟随上游升级，GraphRAG 仍自行维护 |

### 8.5 结论

当前自研是合理的技术选型，不建议改为使用 LlamaIndex。若未来需要做，最多可将**向量检索层**替换为 LlamaIndex 以减少 embedding/切片的维护代码，GraphRAG 继续自研——但这会使代码中同时存在两套风格，增加认知负担，故现状最优。
