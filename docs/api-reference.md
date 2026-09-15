# API 接口列表

## Agent 会话与运行

```text
POST   /api/agent/sessions                         创建会话
GET    /api/agent/sessions                          列出会话（keyset 分页）
GET    /api/agent/sessions/:sessionId               获取会话详情
GET    /api/agent/sessions/:sessionId/history        会话历史事件
PATCH  /api/agent/sessions/:sessionId               更新会话（重命名）
DELETE /api/agent/sessions/:sessionId               删除会话
POST   /api/agent/sessions/:sessionId/runs           发起运行
GET    /api/agent/runs/:runId                        获取运行状态
GET    /api/agent/runs/:runId/events                 SSE 事件流（可恢复）
POST   /api/agent/runs/:runId/approvals/:interruptId  审批响应
POST   /api/agent/runs/:runId/questions/:interruptId  问答响应
POST   /api/agent/runs/:runId/cancel                 取消运行
POST   /api/agent/runs/:runId/artifacts              创建产物上传
POST   /api/agent/artifacts/:artifactId/complete     完成上传
GET    /api/agent/artifacts/:artifactId              下载产物
```

## 项目与 Workspace

```text
GET    /api/agent/projects          列出项目
POST   /api/agent/projects          创建项目（Git / 空白）
POST   /api/agent/projects/upload   上传项目文件
```

## 认证与管理

```text
POST   /api/auth/login              用户名密码登录
POST   /api/auth/register           自助注册
POST   /api/auth/logout             清除会话 Cookie
GET    /api/auth/me                 当前登录用户
GET    /api/admin/users             列出用户（仅 admin）
POST   /api/admin/users             创建用户（仅 admin）
PATCH  /api/admin/users/:userId     修改角色/显示名/重置密码（仅 admin）
GET    /api/admin/users/:userId/knowledge-bases   查询用户被授权的知识库
PUT    /api/admin/users/:userId/knowledge-bases   全量替换知识库授权
```

## 知识库管理

```text
GET    /api/knowledge/bases                        列出知识库
POST   /api/knowledge/bases                        创建知识库
GET    /api/knowledge/bases/:kbId                  获取知识库详情
PATCH  /api/knowledge/bases/:kbId                  更新知识库
DELETE /api/knowledge/bases/:kbId                  删除知识库
POST   /api/knowledge/bases/:kbId/documents        上传文档
GET    /api/knowledge/bases/:kbId/documents        列出文档
DELETE /api/knowledge/bases/:kbId/documents/:docId  删除文档
```
