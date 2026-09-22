# 主分支质量门禁修整设计

## 目标

恢复当前主分支的基础质量基线：根目录 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build` 全部通过，并在 GitHub Actions 中对 Pull Request 与 `main` 分支提交持续执行同一组检查。

## 范围

- 修复 `/api/auth/me` 单元测试夹具与头像 repository 接口不同步的问题。
- 修复可观测性安全文档翻译后，契约测试仍匹配旧英文文案的问题。
- 清除 Web 当前全部 ESLint error，并处理能以低风险方式消除的 warning。
- 新增全仓 CI 工作流，执行冻结依赖安装、Lint、类型检查、单元测试和生产构建。
- 保持现有应用行为、API 协议、数据库结构与部署结构不变。

以下内容不在本次范围：启动 Docker 基础设施、在每个 Pull Request 中执行数据库集成测试、真实模型验收、知识库全链路 E2E、workspace 持久化、资源配额、高可用部署和备份恢复。

## 根因

### API 测试

头像功能向 `/api/auth/me` 增加了 `AgentRepository.getUserAvatarUrl()` 调用，但 `apps/api/test/auth-routes.test.ts` 的轻量 repository 夹具仍只提供显示名与密码查询。运行测试时调用不存在的方法，Fastify 错误处理器因此返回 500。

修复应落在测试夹具：为默认夹具补充返回 `null` 的头像查询，并在 `/api/auth/me` 用例中显式验证头像字段。生产 repository 已实现该接口，不需要增加运行时兼容分支。

### 可观测性契约测试

`docs/observability/security-and-operations.md` 已整体翻译成中文，但测试仍逐字检查旧英文短语。安全约束仍然存在，失败属于文档语言与测试断言不同步。

修复应更新断言，使其验证当前中文文档中的两条安全语义：健康检查只能暴露脱敏摘要，以及不得暴露敏感内部细节。测试继续充当文档契约，不删除该检查。

### Web Lint

当前错误主要来自 Next.js 16 所带 React Hooks 规则：effect 中同步触发状态更新、render 阶段读取可变 ref，以及函数在声明前被 effect 捕获。另有未使用变量、缺失依赖、内部导航和动态图片警告。

修复采用代码级重构，不全局关闭规则：

- 异步加载在 effect 内建立取消边界，只在 Promise 回调中更新状态。
- 可由 props、URL 或已有状态推导的值直接推导，不再通过 effect 镜像。
- 需要在实体切换时重置的局部 UI 状态，通过 keyed 子组件或事件入口初始化。
- 会影响渲染的拖拽状态使用 state；ref 仅保存不参与渲染的瞬时坐标。
- 内部导航使用 Next Router；未使用变量和依赖数组按实际数据流修正。
- 对用户上传、Blob、签名 URL 或 Markdown 动态图片，保留原生 `<img>` 的场景使用局部、带说明的规则豁免；不关闭全局图片规则。

## CI 设计

新增 `.github/workflows/ci.yml`：

- 触发条件：Pull Request，以及推送到 `main`。
- 并发策略：同一分支只保留最新运行。
- 环境：Ubuntu、Node.js 22、pnpm 11.24.0，启用 pnpm 缓存。
- 单一质量任务依次执行：
  1. `pnpm install --frozen-lockfile`
  2. `pnpm lint`
  3. `pnpm typecheck`
  4. `pnpm test`
  5. `pnpm build`

单一任务避免重复安装依赖，并确保后续步骤只在前置质量门禁通过时运行。本轮不注入模型密钥，不启动外部基础设施；现有需要真实服务的测试继续由环境开关保护。

## 测试策略

修复遵循现有失败作为 RED 基线：

- API 两个现有失败用例必须由失败转为通过。
- ESLint 当前 25 个 error 是前端重构的失败基线；逐类修复并在每组修改后复跑 Web Lint。
- 前端重构不得改变现有交互，复跑 Web 测试和类型检查。
- CI YAML 通过结构检查，并最终以根目录四条质量命令验证。

最终验收：

- `pnpm lint` 退出码为 0，不新增全局规则关闭。
- `pnpm typecheck` 13 个 workspace 全部通过。
- `pnpm test` 全部非环境门控测试通过。
- `pnpm build` 13 个 workspace 全部通过。
- `git diff --check` 无空白错误。

## 风险控制

- React 状态重构容易造成初始化时序变化，因此每次只处理同一类 Lint 规则，并复跑相关测试与类型检查。
- CI 中 Node 测试会监听临时本地端口；GitHub Ubuntu runner 支持该行为，不在受限沙箱中模拟失败。
- 动态图片若强行迁移到 `next/image` 可能破坏 Blob、Data URL 或签名 URL，本轮只在适用场景迁移，其余使用局部规则说明。
- 不把全链路 E2E 混入本次快速门禁，避免 CI 因第三方模型或基础设施波动失去可信度。
