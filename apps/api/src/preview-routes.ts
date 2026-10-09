import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '@repo/contracts';
import type { ApiServices } from './types.js';
import { issuePreviewAccess, verifyPreviewAccess } from './preview-access.js';
import { readPreviewFile, validatePreviewMount, PreviewFileError } from './preview-files.js';

async function authorizedSession(services: ApiServices, auth: AuthContext | undefined, id: string) {
  if (!auth) return null;
  // PostgreSQL 的 UUID 输入不接受外部键；只有输入为 UUID 时才尝试内部查询。
  const internal = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? await services.repository.getSession(auth, id) : null;
  return internal ?? await services.repository.getSessionByExternalKey(auth, id);
}
const MIME: Record<string,string> = {'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'};
export function registerPreviewRoutes(app: FastifyInstance, services: ApiServices) {
  app.post('/api/agent/sessions/:sessionId/preview-token', async (request, reply) => {
    const {sessionId} = request.params as {sessionId:string};
    const session = await authorizedSession(services, request.auth, sessionId);
    if (!session) return reply.code(404).send({error:'session_not_found'});
    try {
      const token = issuePreviewAccess(services.config, request.auth, session.id);
      return {url: `/api/agent/sessions/${encodeURIComponent(session.id)}/preview-cap/${token}/`, expiresIn: 900};
    } catch { return reply.code(503).send({error:'preview_capability_not_configured'}); }
  });
  const serve: import('fastify').RouteHandlerMethod = async (request, reply) => {
    const {sessionId} = request.params as {sessionId:string};
    const wildcard = (request.params as Record<string,string>)['*'] ?? '';
    const capabilityRoute = request.routeOptions.url?.includes('/preview-cap/');
    const [token, ...resource] = capabilityRoute ? wildcard.split('/') : []; 
    const auth = token ? verifyPreviewAccess(services.config, token, sessionId) : request.auth;
    if (!auth) return reply.code(401).send({error:'unauthorized'});
    const session = await authorizedSession(services, auth, sessionId);
    if (!session) return reply.code(404).send({error:'session_not_found'});
    if (services.config.SANDBOX_RUNTIME !== 'docker') return reply.code(404).send({error:'sandbox_not_found'});
    const workspace = await services.repository.getWorkspaceSandboxForWorker(auth.tenantId, session.id);
    if (!workspace) return reply.code(404).send({error:'sandbox_not_found'});
    const requested = (capabilityRoute ? resource.join('/') : wildcard) || 'index.html';
    try {
      const content = await readPreviewFile(services.config.SANDBOX_SESSIONS_ROOT, workspace.workspaceId, requested, services.config.NODE_ENV === 'production');
      // 沙箱 iframe 使用不透明来源，无法依赖 SameSite 登录 Cookie 请求资源。
      // 将已认证的 HTML 入口重定向到仅对当前会话开放的能力根路径。
      if (!capabilityRoute && /\.html?$/i.test(requested)) {
        const access = issuePreviewAccess(services.config, auth, session.id);
        const resource = requested === 'index.html' ? '' : requested.split('/').map(encodeURIComponent).join('/');
        return reply.header('cache-control','private, no-store').header('referrer-policy','no-referrer')
          .redirect(`/api/agent/sessions/${encodeURIComponent(session.id)}/preview-cap/${access}/${resource}`);
      }
      if (capabilityRoute) {
        // 沙箱文档使用不透明来源；其模块、字体和 fetch 请求通过限定范围的 URL 认证，
        // 不使用登录凭据。
        reply.header('access-control-allow-origin', '*');
        reply.removeHeader('access-control-allow-credentials');
      }
      return reply.header('content-type', MIME[path.extname(requested).toLowerCase()] ?? 'application/octet-stream')
        .header('cache-control','private, no-store').header('referrer-policy','no-referrer')
        .header('x-content-type-options','nosniff')
        .header('content-security-policy', "sandbox allow-scripts allow-forms allow-downloads; frame-ancestors 'self'").send(content);
    } catch (error) {
      if (error instanceof PreviewFileError) return reply.code(error.status).send({error:error.code});
      request.log.warn({operation:'preview.read'}, 'preview unavailable');
      return reply.code(404).send({error:'preview_file_unavailable'});
    }
  };
  app.get('/api/agent/sessions/:sessionId/preview', serve);
  app.get('/api/agent/sessions/:sessionId/preview/*', serve);
  app.get('/api/agent/sessions/:sessionId/preview-cap/*', serve);
  const SANDBOX_IMAGE = process.env.DOCKER_SANDBOX_IMAGE?.trim() ?? 'chat-agent-sandbox:latest';
  const DOCKER_WORKSPACE = '/mnt/user-data/workspace';
  /** 在沙箱容器内重新构建项目（vite build），产物输出到 workspace/dist/。 */
  app.post('/api/agent/sessions/:sessionId/rebuild', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = await authorizedSession(services, request.auth, sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const workspace = await services.repository.getWorkspaceSandboxForWorker(request.auth.tenantId, session.id);
    if (!workspace) return reply.code(404).send({ error: 'sandbox_not_found' });
    if (services.config.SANDBOX_RUNTIME !== 'docker') {
      return reply.code(400).send({ error: 'rebuild_requires_docker' });
    }
    let sandboxPath: string;
    try { sandboxPath = await validatePreviewMount(services.config.SANDBOX_SESSIONS_ROOT, workspace.workspaceId); }
    catch { return reply.code(403).send({error: 'invalid_sandbox_path'}); }

    const containerName = `rebuild-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
    const buildScript = [
      'set -e',
      `cd ${DOCKER_WORKSPACE}`,
      // 查找包含 package.json 的项目目录
      'PROJECT_DIR="."',
      'if [ ! -f package.json ]; then',
      '  for d in */; do',
      '    if [ -f "${d}package.json" ]; then PROJECT_DIR="${d}"; break; fi',
      '  done',
      'fi',
      'cd "$PROJECT_DIR"',
      `npx vite build --base ./ --outDir ${DOCKER_WORKSPACE}/dist 2>&1`,
    ].join('\n');

    const args = [
      'run', '--rm',
      '--name', containerName,
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '128',
      '--memory', '768m',
      '--cpus', '1.5',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--user', '65532:65532',
      '--env', 'HOME=/tmp',
      '--workdir', DOCKER_WORKSPACE,
      '--mount', `type=bind,src=${sandboxPath},dst=/mnt/user-data`,
      SANDBOX_IMAGE,
      '/bin/bash', '-lc', buildScript,
    ];

    const output = await new Promise<{ stdout: string; exitCode: number }>((resolveExec) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = 100_000;
      child.stdout.on('data', (chunk: Buffer) => {
        if (totalBytes < maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - totalBytes));
          totalBytes += chunk.length;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (totalBytes < maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - totalBytes));
          totalBytes += chunk.length;
        }
      });
      child.once('error', () => resolveExec({ stdout: 'Docker 执行出错', exitCode: 1 }));
      child.once('close', (code) => resolveExec({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode: code ?? 1,
      }));
    });

    if (output.exitCode === 0) {
      return { status: 'ok', previewUrl: `/api/agent/sessions/${sessionId}/preview/` };
    }
    return reply.code(500).send({ error: 'build_failed', output: output.stdout.slice(0, 5000) });
  });
}
