# Electron Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently packaged Electron client that securely loads the deployed Keen AI Web application without changing Web pages or routes.

**Architecture:** Create `apps/desktop` as a separate pnpm workspace containing only an Electron main process and local load-error page. Pure TypeScript modules validate the configured Web URL and classify navigation so they can be tested without launching Electron; electron-builder packages the compiled main process and dedicated icon assets.

**Tech Stack:** Electron, electron-builder, TypeScript 5, Node.js built-in test runner, tsx, pnpm workspaces, Turbo

**Spec:** `docs/superpowers/specs/2026-09-14-electron-client-design.md`

## Global Constraints

- Do not modify `apps/web` pages, routes, styles, or Next.js build configuration.
- The desktop client loads `ELECTRON_WEB_URL`; development falls back to `http://localhost:3000`.
- Only `http:` and `https:` URLs without embedded credentials are accepted.
- Renderer security must keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, with no preload bridge.
- Packaging uses product name `Keen AI`; unsigned macOS and Windows artifacts are sufficient.
- `pnpm build` compiles desktop code but must not create installers; installer creation remains an explicit desktop command.

---

### Task 1: Testable URL and navigation policy

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/config.ts`
- Create: `apps/desktop/src/navigation.ts`
- Create: `apps/desktop/test/config.test.ts`
- Create: `apps/desktop/test/navigation.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `resolveWebUrl(rawValue: string | undefined, isPackaged: boolean): URL`
- Produces: `classifyNavigation(target: URL, appOrigin: string): 'allow' | 'external' | 'deny'`
- Produces: `DEFAULT_DEVELOPMENT_URL = 'http://localhost:3000'`

- [ ] **Step 1: Scaffold the workspace and add failing policy tests**

Create a private ESM package named `@repo/desktop` with scripts `build`, `dev`, `start`, `typecheck`, `test`, `dist`, `dist:mac`, and `dist:win`; set `main` to `dist/main.js`. Add `electron`, `electron-builder`, `tsx`, `typescript`, and `@types/node` as development dependencies. Configure TypeScript with `module` and `moduleResolution` set to `NodeNext`, `rootDir` as `src`, `outDir` as `dist`, and include only `src/**/*.ts`.

Write tests that assert:

```ts
assert.equal(resolveWebUrl(undefined, false).href, 'http://localhost:3000/');
assert.equal(resolveWebUrl(' https://chat.example.com/app ', true).href, 'https://chat.example.com/app');
assert.throws(() => resolveWebUrl(undefined, true), /ELECTRON_WEB_URL/);
assert.throws(() => resolveWebUrl('file:///tmp/index.html', false), /http/);
assert.throws(() => resolveWebUrl('https://user:secret@example.com', false), /credentials/);
assert.equal(classifyNavigation(new URL('https://chat.example.com/login'), 'https://chat.example.com'), 'allow');
assert.equal(classifyNavigation(new URL('https://docs.example.com'), 'https://chat.example.com'), 'external');
assert.equal(classifyNavigation(new URL('javascript:alert(1)'), 'https://chat.example.com'), 'deny');
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --filter @repo/desktop test`

Expected: FAIL because `src/config.ts` and `src/navigation.ts` do not exist.

- [ ] **Step 3: Implement the minimal pure policy modules**

Implement `resolveWebUrl` with `URL`, accepting only HTTP(S), rejecting an empty production value, a missing hostname, and embedded username/password. Implement `classifyNavigation` so matching origins return `allow`, other HTTP(S) origins return `external`, and all other protocols return `deny`.

- [ ] **Step 4: Run desktop policy tests and typecheck**

Run: `pnpm --filter @repo/desktop test && pnpm --filter @repo/desktop typecheck`

Expected: all tests pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit the policy foundation**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/src/config.ts apps/desktop/src/navigation.ts apps/desktop/test pnpm-lock.yaml
git commit -m "feat(desktop): add URL and navigation policy"
```

### Task 2: Secure Electron window and load-error experience

**Files:**
- Create: `apps/desktop/src/window-options.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/assets/load-error.html`
- Create: `apps/desktop/test/window-options.test.ts`

**Interfaces:**
- Consumes: `resolveWebUrl(rawValue, app.isPackaged)` from Task 1
- Consumes: `classifyNavigation(target, webUrl.origin)` from Task 1
- Produces: `createWindowOptions(): BrowserWindowConstructorOptions`
- Produces: Electron application lifecycle entry at `dist/main.js`

- [ ] **Step 1: Write a failing BrowserWindow security test**

Test the returned options without creating a native window:

```ts
const options = createWindowOptions();
assert.equal(options.width, 1280);
assert.equal(options.height, 800);
assert.equal(options.minWidth, 960);
assert.equal(options.minHeight, 640);
assert.equal(options.show, false);
assert.equal(options.webPreferences?.nodeIntegration, false);
assert.equal(options.webPreferences?.contextIsolation, true);
assert.equal(options.webPreferences?.sandbox, true);
assert.equal(options.webPreferences?.preload, undefined);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @repo/desktop test`

Expected: FAIL because `src/window-options.ts` does not exist.

- [ ] **Step 3: Implement window creation and lifecycle**

Implement the tested options and a main process that:

- resolves `ELECTRON_WEB_URL` before creating a window;
- displays a native error and calls `app.quit()` when configuration is invalid;
- creates one BrowserWindow and shows it on `ready-to-show`;
- denies all `window.open` calls, opening external HTTP(S) URLs with `shell.openExternal`;
- intercepts top-level navigation, allows the configured origin, opens other HTTP(S) origins externally, and denies dangerous protocols;
- loads the packaged `assets/load-error.html` with encoded query parameters after a failed main-frame load;
- supports a retry link through a fixed `keen-ai-retry:` navigation sentinel handled only by the main process, plus a CSP-protected local error page;
- recreates the window from `activate` on macOS and quits on `window-all-closed` elsewhere.

The local error page exposes only an anchor to `keen-ai-retry:`; do not register it as an OS protocol, enable Node in the renderer, add inline scripts, or add a preload bridge.

- [ ] **Step 4: Run tests, typecheck, and compile**

Run: `pnpm --filter @repo/desktop test && pnpm --filter @repo/desktop typecheck && pnpm --filter @repo/desktop build`

Expected: all commands pass and `apps/desktop/dist/main.js` exists.

- [ ] **Step 5: Launch against a deterministic local HTTP server**

Run a temporary local server on an unused loopback port, then launch Electron with `ELECTRON_WEB_URL` set to it and verify the window reaches `ready-to-show` without renderer console errors. Terminate both development processes after the smoke check.

- [ ] **Step 6: Commit the Electron runtime**

```bash
git add apps/desktop/src apps/desktop/assets/load-error.html apps/desktop/test/window-options.test.ts apps/desktop/package.json
git commit -m "feat(desktop): add secure Electron runtime"
```

### Task 3: Packaging, project commands, and documentation

**Files:**
- Create: `apps/desktop/assets/icon.png`
- Create: `apps/desktop/assets/icon.icns`
- Create: `apps/desktop/assets/icon.ico`
- Create: `apps/desktop/README.md`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: compiled Electron entry from Task 2
- Produces: `pnpm desktop:dev`, `desktop:typecheck`, `desktop:test`, `desktop:dist`, `desktop:dist:mac`, and `desktop:dist:win`
- Produces: electron-builder artifacts under `apps/desktop/release/`

- [ ] **Step 1: Add electron-builder configuration and icon assets**

Generate 1024×1024 PNG, ICNS, and ICO assets from `apps/web/public/keen-ai-logo.png`. Configure:

```json
{
  "appId": "com.keenai.desktop",
  "productName": "Keen AI",
  "directories": { "output": "release" },
  "files": ["dist/**/*", "assets/load-error.html", "package.json"],
  "mac": { "target": ["dmg", "zip"], "icon": "assets/icon.icns" },
  "win": { "target": ["nsis", "zip"], "icon": "assets/icon.ico" },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```

Ensure `electron-builder` rebuilds from the workspace package and does not bundle repository source, `.env`, tests, or Web build output.

- [ ] **Step 2: Add isolated root commands and build output declarations**

Add root scripts that use `pnpm --filter @repo/desktop ...`; do not alter existing script bodies or the existing Turbo graph. Add `apps/desktop/release/` to `.gitignore`.

- [ ] **Step 3: Document local and packaged usage**

Document these exact flows in `apps/desktop/README.md`:

```bash
# terminal 1: existing services
pnpm dev

# terminal 2: desktop shell using localhost:3000
pnpm desktop:dev

# remote deployment
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dev

# unsigned platform package
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist:mac
```

Explain that the packaged application needs `ELECTRON_WEB_URL` in its launch environment, that installer signing/notarization is not included, and that no Web pages are changed.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
pnpm --filter @repo/desktop test
pnpm --filter @repo/desktop typecheck
pnpm --filter @repo/desktop build
pnpm --filter web test
pnpm --filter web typecheck
pnpm --filter web build
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits with code 0. Confirm `git diff --name-only HEAD~3` contains no file below `apps/web/app/` and no change to `apps/web/next.config.ts`.

- [ ] **Step 5: Build the current-platform unsigned installer**

Run: `ELECTRON_WEB_URL=https://example.com pnpm desktop:dist:mac`

Expected on macOS: electron-builder exits successfully and creates a DMG and ZIP below `apps/desktop/release/`. Windows packaging remains configured and is validated by electron-builder configuration; run it on Windows or a compatible CI runner for final Windows artifact verification.

- [ ] **Step 6: Commit packaging and documentation**

```bash
git add apps/desktop/assets apps/desktop/README.md apps/desktop/package.json package.json .gitignore pnpm-lock.yaml
git commit -m "build(desktop): add Electron packaging"
```

### Task 4: Final requirements audit

**Files:**
- Verify: `docs/superpowers/specs/2026-09-14-electron-client-design.md`
- Verify: all files changed by Tasks 1–3

**Interfaces:**
- Consumes: all deliverables from Tasks 1–3
- Produces: evidence-backed handoff of commands, artifacts, and unchanged Web scope

- [ ] **Step 1: Audit security and scope**

Use `rg` to confirm the only BrowserWindow construction keeps the three required webPreferences, no `preload` file exists, and no desktop-specific condition was added beneath `apps/web`.

- [ ] **Step 2: Audit repository state**

Run `git status --short`, inspect every remaining diff, and confirm generated `dist/` and `release/` outputs are ignored rather than committed.

- [ ] **Step 3: Report completion evidence**

Report the desktop commands, configuration variable, successful checks, installer artifact paths and sizes, and any platform-signing limitation. Do not claim Windows artifact verification unless it ran successfully on Windows or a compatible runner.
