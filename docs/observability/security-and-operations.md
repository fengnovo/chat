# 可观测性安全与运维

## 配置契约

`.env.example` 和 `deploy/env.production.example` 有意包含相同的可观测性配置键。它们是模板，不是凭据存储。本地开发保持 `OTEL_ENABLED=false` 和 `OBSERVABILITY_CAPTURE_CONTENT=false`。生产环境使用基于父级的 trace-ID 比率采样，初始比率为 `0.05`；staging 应使用 100% trace 采样（`OTEL_TRACES_SAMPLER_ARG=1`）。错误请求和明确调试的运行可以通过批准的运行时控制提高采样率，但用户 ID 绝不能用作遥测标签。

OTLP header 和 Langfuse 密钥在仓库模板中保持为空。在运行时从部署密钥管理器注入。绝不要向 Git 添加新凭据。

## 历史凭据清理

较早的 Git 历史版本中 `.env.example` 包含疑似 Langfuse 凭据。在生产上线之前，凭据负责人必须撤销并轮换这些凭据，并确认替换凭据仅由密钥管理器注入。安全负责人决定是否需要重写 Git 历史，并且必须保留该决策及任何重写操作的审计记录。

## 保留期限与隐私

- 指标：30 天。
- 普通日志：14 天。
- Trace：7 天。
- Langfuse 数据：30 天。
- 生产环境内容捕获：已禁用。

删除请求和访问审计仍遵循现有的 PostgreSQL 治理流程。遥测必须使用低基数的运维标识符；不要将用户 ID、prompt、completion、工具输入或输出、文档内容或元数据、或密钥放入标签或捕获的内容中。

## 公开健康检查响应

公开健康检查响应仅暴露脱敏后的状态、版本和组件摘要。绝不能暴露密钥、DSN、原始错误、堆栈跟踪、主机名或其他内部连接细节。这是健康检查端点实现的契约；可观测性测试覆盖响应边界，但不要求在此任务中实现端点。

## 运维护栏

遥测对业务流量必须是 fail-open 的：exporter 或 collector 中断不得导致 API 请求或 Worker 任务失败。关闭时的 flush 操作受 `OBSERVABILITY_SHUTDOWN_TIMEOUT_MS` 限制（生产模板中为五秒）。如果密钥出现在日志、trace 或仓库产物中，立即轮换凭据，然后记录事件并验证下游撤销。
