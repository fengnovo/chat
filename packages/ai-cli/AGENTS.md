# AGENTS.md — 项目约定与经验记录

## 文件命名与模块系统

- 上级 `package.json` 含 `"type": "module"`，所有 `.js` 文件会被视为 ES Module。
- 如果使用 CommonJS（`require` / `module.exports`），必须使用 `.cjs` 扩展名。
- 对应的测试文件也应使用 `.cjs` 扩展名以保持一致。

