# Keen Agent 官网

这是一个不依赖构建工具的独立静态站点。

## 本地预览

在仓库根目录执行：

```bash
python3 -m http.server 4173 --directory docs/website
```

然后访问 <http://localhost:4173>。

## 自动部署

`.github/workflows/deploy-website.yml` 会在 `main` 分支中的官网文件发生变化时自动发布到 GitHub Pages，也支持在 Actions 页面手动触发。

仓库首次使用时，需要在 GitHub 的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。此后无需手动部署。

## 验证

```bash
node --test docs/website/site.test.mjs
```
