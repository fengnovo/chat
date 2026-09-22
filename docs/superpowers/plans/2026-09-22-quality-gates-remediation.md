# 主分支质量门禁修整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复当前主分支的 API 测试回归和 Web ESLint 错误，并新增稳定的全仓 CI 质量门禁。

**Architecture:** 保持现有 API、数据库、Web 和部署接口不变。测试回归通过同步测试夹具/契约断言解决；Web 只做局部 React 状态与事件流重构；CI 使用单一 Ubuntu job 复用一次依赖安装，按 lint → typecheck → test → build 顺序阻断后续步骤。

**Tech Stack:** Node.js 22、pnpm 11.24.0、Turbo、TypeScript、Next.js 16、React 19、ESLint 9、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-22-quality-gates-design.md`

## Global Constraints

- 不改变 API 响应协议、数据库迁移、业务状态机和部署入口。
- 不全局关闭 React/Next ESLint 规则；动态图片仅在确实需要原生 `<img>` 的组件位置做局部说明性豁免。
- 不把真实模型密钥或外部服务凭据放入 CI。
- 每个任务先运行对应的失败/回归检查，再实施最小改动，再运行相关检查。
- 最终必须验证 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check`。

---

### Task 1: 修复 API 测试夹具与文档契约回归

**Files:**
- Modify: `apps/api/test/auth-routes.test.ts`
- Modify: `apps/api/test/observability-config-contract.test.ts`
- Read-only contract: `docs/observability/security-and-operations.md`

**Interfaces:**
- Consumes: `registerAuthRoutes`, `AgentRepository` test double, observability policy text.
- Produces: `/api/auth/me` tests that cover the avatar field and a language-synchronized security policy contract.

- [ ] **Step 1: Run the two failing tests and record the RED failures**

  Run:

  ```bash
  pnpm --filter @repo/agent-api exec node --conditions=development --import tsx --test test/auth-routes.test.ts test/observability-config-contract.test.ts
  ```

  Expected: `/api/auth/me` returns 500 instead of 200, and the policy test reports missing English phrases.

- [ ] **Step 2: Extend the auth test fixture minimally**

  In `makeApp`, provide `getUserAvatarUrl: async () => null` as the default repository method so tests that are not about avatars remain valid. In the display-name test, override that method to return a stable avatar URL and assert `avatarUrl` in the response. Do not add a production fallback for a missing repository method.

- [ ] **Step 3: Synchronize the observability contract assertion with the current Chinese policy**

  Replace the two exact English phrases with the corresponding Chinese sentences currently present in `docs/observability/security-and-operations.md`. Keep the assertions focused on the two security guarantees, not on headings or incidental wording.

- [ ] **Step 4: Run the focused tests again**

  Run the command from Step 1.

  Expected: all tests in both files pass with zero failures.

- [ ] **Step 5: Run the full API package test**

  Run:

  ```bash
  pnpm --filter @repo/agent-api test
  ```

  Expected: 94 tests, zero failures.

### Task 2: Clear Web ESLint errors by local state/data-flow fixes

**Files:**
- Modify: `apps/web/app/admin/users/page.tsx`
- Modify: `apps/web/app/components/resilient-chat/chat-runtime.tsx`
- Modify: `apps/web/app/components/resilient-chat/file-panel.tsx`
- Modify: `apps/web/app/components/resilient-chat/lightbox.tsx`
- Modify: `apps/web/app/knowledge/chunks-view.tsx`
- Modify: `apps/web/app/knowledge/documents-view.tsx`
- Modify: `apps/web/app/knowledge/knowledge-console.tsx`
- Modify: `apps/web/app/knowledge/retrieval-view.tsx`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/app/memory/page.tsx`
- Modify as needed for warning cleanup: `apps/web/app/components/ai-service-widget.tsx`, `apps/web/app/components/auth/user-menu.tsx`, `apps/web/app/components/resilient-chat/api.ts`, `apps/web/app/components/resilient-chat/events.ts`, `apps/web/app/components/resilient-chat/message.tsx`, `apps/web/app/components/resilient-chat/citation-list.tsx`, `apps/web/app/components/resilient-chat/composer.tsx`, `apps/web/app/customer-service/customer-service-chat.tsx`, `apps/web/app/knowledge/knowledge-ui.tsx`

**Interfaces:**
- Consumes: existing component props, API functions and persistence helpers.
- Produces: identical user-visible behavior with no Web ESLint errors and no new global rule suppression.

- [ ] **Step 1: Capture the current Web lint failure by rule**

  Run:

  ```bash
  pnpm --filter web lint
  ```

  Expected: current React Hooks errors are reproduced before code changes.

- [ ] **Step 2: Fix effect-triggered async loading**

  For admin users, memory, knowledge console/chunks/documents/retrieval and chat runtime, keep asynchronous work inside the effect with a cancellation flag or abort guard. Avoid invoking a stateful callback directly as the effect body expression when the rule treats it as synchronous state cascading. Preserve loading/error behavior and cleanup on unmount.

- [ ] **Step 3: Remove effect-based state mirrors and declaration-order violations**

  For knowledge console and retrieval/document views, derive selected values from props/state where possible. Move `selectKb` before the effect that uses it, or wrap it in `useCallback` with its real dependencies. Reset state only when the user changes the entity or through a keyed child boundary, not through an unconditional render loop.

- [ ] **Step 4: Separate render-visible drag state from mutable pointer data**

  In lightbox and file panel, keep pointer coordinates and active pointer bookkeeping in refs, but store `isDragging`/equivalent render-visible state in React state. Render cursor/class values from state rather than reading `.current` during render. Preserve pointer capture and release behavior.

- [ ] **Step 5: Fix login/chat callback dependencies and unused values**

  Remove unused imports/state setters, include stable callback dependencies, and use the router for internal navigation where Next’s rule requires it. Do not change external OAuth or session semantics.

- [ ] **Step 6: Handle dynamic image warnings locally**

  Keep native `<img>` only where the source is runtime-generated, Blob/data/signed URL, or Markdown-controlled. Add a short local ESLint disable comment with the reason at those narrow locations. Convert straightforward static/remote cases to the existing project-supported image component only if the source contract remains valid.

- [ ] **Step 7: Run Web lint and Web tests**

  Run:

  ```bash
  pnpm --filter web lint
  pnpm --filter web test
  pnpm --filter web typecheck
  ```

  Expected: lint exits 0, tests pass, and typecheck exits 0.

### Task 3: Add the GitHub Actions quality gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root package scripts, `pnpm-lock.yaml`, existing Node/pnpm versions.
- Produces: required CI checks for Pull Requests and pushes to `main`.

- [ ] **Step 1: Validate the intended root commands locally**

  Confirm the commands exist in `package.json` and run from repository root:

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  ```

- [ ] **Step 2: Create the workflow with one quality job**

  Use `actions/checkout@v4`, `pnpm/action-setup@v4` with pnpm `11.24.0`, `actions/setup-node@v4` with Node `22` and pnpm cache, then run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Add branch-scoped concurrency with `cancel-in-progress: true`.

- [ ] **Step 3: Keep the workflow credential-free and infrastructure-free**

  Do not add model keys, database services, Docker startup, or external secrets. Environment-gated integration tests must remain skipped unless explicitly enabled by a later workflow.

- [ ] **Step 4: Validate workflow syntax and repository diff**

  Run a YAML parser available in the environment, or use the GitHub workflow syntax checker if available. Then run:

  ```bash
  git diff --check
  ```

  Expected: valid YAML and no whitespace errors.

### Task 4: Full regression and handoff

**Files:**
- No additional production files; inspect all changes from Tasks 1–3.

- [ ] **Step 1: Run the complete quality commands in order**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  ```

- [ ] **Step 2: Verify test scope and environment-gated cases**

  Record any explicitly skipped integration/E2E tests and confirm no test was made weaker or globally disabled.

- [ ] **Step 3: Inspect the final diff**

  ```bash
  git diff --check
  git status --short
  git diff --stat
  ```

- [ ] **Step 4: Report exact results**

  Include changed files, command exit codes, test pass/fail/skip counts, and the remaining out-of-scope production gaps.
