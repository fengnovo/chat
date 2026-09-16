import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const siteRoot = new URL('./', import.meta.url);
const repoRoot = new URL('../../', siteRoot);

async function read(path) {
  return readFile(new URL(path, siteRoot), 'utf8');
}

test('homepage presents Keen Agent and the production chat entry', async () => {
  const html = await read('index.html');

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Keen Agent/);
  assert.match(html, /Headless Agent/);
  assert.match(html, /自主规划/);
  assert.match(html, /断线/);
  assert.match(html, /可观测/);
  assert.match(html, /https:\/\/chat\.keen-tech\.top\/keen-ai-logo\.png/);
  assert.match(
    html,
    /<a[^>]+href="https:\/\/chat\.keen-tech\.top"[^>]*>[^<]*(?:立即体验|进入 Keen Agent)/,
  );
});

test('homepage reflects the real Keen Agent product interface', async () => {
  const html = await read('index.html');
  const css = await read('styles.css');

  assert.match(html, /class="app-preview"/);
  assert.match(html, /class="preview-sidebar"/);
  assert.match(html, /class="preview-chat"/);
  assert.match(html, /新建对话/);
  assert.match(html, /描述要在项目中完成的任务/);

  assert.match(css, /--violet: #6d4aff/);
  assert.match(css, /--violet-soft: #eeeaff/);
  assert.match(css, /--sidebar: #f5f4f8/);
  assert.doesNotMatch(css, /--orange:/);
  assert.doesNotMatch(html, /runtime-card/);
});

test('homepage includes accessible navigation and responsive metadata', async () => {
  const html = await read('index.html');

  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<nav[^>]+aria-label="主导航"/);
  assert.match(html, /<main id="main-content">/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('styles include keyboard focus, mobile layout, and reduced-motion support', async () => {
  const css = await read('styles.css');

  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('GitHub Pages workflow deploys the standalone website directory', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/deploy-website.yml', repoRoot),
    'utf8',
  );

  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /path: docs\/website/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});
