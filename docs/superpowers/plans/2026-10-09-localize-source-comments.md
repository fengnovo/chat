# Source Comment Localization Implementation Plan

> **For agentic workers:** Use inline execution for this request; follow each checklist item and verify the final diff.

**Goal:** Translate English explanatory comments in project-maintained source and configuration files into Chinese without changing runtime behavior.

**Architecture:** This is a comment-only editorial pass across tracked application, package, test, script, and deployment sources. Preserve identifiers, commands, protocol names, legal notices, generated-file headers, and user-facing strings. Review every changed hunk as comment text.

**Tech Stack:** TypeScript/TSX, JavaScript, shell, Python, SQL, Kotlin, Swift, CSS, YAML, XML.

**Spec:** User request in conversation: “将整个项目的英文注释都改成中文”.

## Global Constraints

- Change project-maintained explanatory comments only.
- Preserve code, string literals, commands, identifiers, protocol terms, and behavior.
- Keep third-party copyright/license text and generated-file instructions intact.
- Do not edit dependencies, build output, caches, lockfiles, or documentation prose.

---

### Task 1: Inventory and scope source comments

**Files:**
- Read tracked source/config files across `apps/`, `packages/`, `scripts/`, `deploy/`, and `infra/`.
- Exclude dependencies, generated outputs, documentation prose, and legal attribution.

- [x] Identify English explanatory comments and false positives.
- [x] Re-scan for remaining English prose comments after edits.

### Task 2: Translate comments in source and configuration

**Files:**
- Modify all tracked project-maintained source/config files containing English explanatory comments, across the directories above.

- [x] Translate explanatory prose while preserving comment syntax and technical identifiers.
- [x] Review the diff to ensure only comments changed.

### Task 3: Verify the editorial pass

**Files:**
- Test: `git diff --check` and a final comment inventory.

- [x] Confirm no whitespace errors.
- [x] Confirm no English prose comments remain within the agreed scope.
- [x] Confirm executable source outside comment ranges is unchanged.
