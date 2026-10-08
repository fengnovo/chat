#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
env.ANDROID_HOME ??=
  env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
const studioJdk = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
if (!env.JAVA_HOME && existsSync(studioJdk)) env.JAVA_HOME = studioJdk;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run("pnpm", [
    "--filter",
    "mobile",
    "exec",
    "expo",
    "prebuild",
    "--platform",
    "android",
    "--no-install",
  ]);
  run(
    "./gradlew",
    [
      "app:assembleRelease",
      "-x",
      "lint",
      "-x",
      "test",
      "--build-cache",
      `-PreactNativeArchitectures=${env.ANDROID_ARCHITECTURES ?? "arm64-v8a,armeabi-v7a,x86,x86_64"}`,
    ],
    join(root, "apps/mobile/android"),
  );
  console.log(
    "\nAPK: " +
      join(
        root,
        "apps/mobile/android/app/build/outputs/apk/release/app-release.apk",
      ),
  );
  console.log(
    "JS is bundled; no Metro / port 8081 is required. Uses the current project signing configuration.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
