#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = join(root, 'apps/mobile');
const cache = join(root, 'node_modules/.cache/mobile');
const target = process.argv[2] ?? 'all';
if (['--help', '-h'].includes(target)) {
  console.log(
    `Usage: pnpm mobile:run [android|ios|all]\n\nRebuild, install and launch a Debug app on simulators. Reuses Metro on port 8081,\nor starts it in the background. Does not start the API or Worker.\n\nOptional environment variables:\n  ANDROID_SERIAL   Existing emulator serial (e.g. emulator-5554)\n  ANDROID_AVD      AVD to boot when no emulator is running\n  IOS_SIMULATOR   iOS simulator name or UDID\n  ANDROID_HOME / JAVA_HOME  Override Android tools\n\nLogs and iOS build output: node_modules/.cache/mobile/\nStop the Metro instance started by this script with the PID it prints.`,
  );
  process.exit(0);
}
if (!['android', 'ios', 'all'].includes(target)) {
  console.error('Expected android, ios or all. Run with --help for usage.');
  process.exit(1);
}
const env = { ...process.env };
mkdirSync(cache, { recursive: true });
function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} failed (${code})`)),
    );
  });
}
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
function background(command, args, filename) {
  const fd = openSync(join(cache, filename), 'a');
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.on('error', (error) => console.error(error.message));
  child.unref();
  return child;
}
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function metroReady() {
  try {
    const response = await fetch('http://127.0.0.1:8081/status', {
      signal: AbortSignal.timeout(2000),
    });
    return (await response.text()).includes('packager-status:running');
  } catch {
    return false;
  }
}
async function ensureMetro() {
  if (await metroReady()) {
    console.log(
      '[mobile] Reusing Metro on 8081; ensure it belongs to this project.',
    );
    return;
  }
  const child = background(
    'pnpm',
    [
      '--filter',
      'mobile',
      'exec',
      'expo',
      'start',
      '--localhost',
      '--port',
      '8081',
    ],
    'metro.log',
  );
  console.log(
    `[mobile] Starting Metro, PID ${child.pid}; log: ${join(cache, 'metro.log')}`,
  );
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await metroReady()) return;
    if (child.exitCode !== null) break;
    await delay(1000);
  }
  throw new Error(
    'Metro did not start. Check metro.log (including whether port 8081 is occupied).',
  );
}
async function android() {
  const sdk =
    env.ANDROID_HOME ??
    env.ANDROID_SDK_ROOT ??
    join(homedir(), 'Library/Android/sdk');
  env.ANDROID_HOME = sdk;
  if (
    !env.JAVA_HOME &&
    existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
  )
    env.JAVA_HOME =
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  const adb = join(sdk, 'platform-tools/adb');
  const emulator = join(sdk, 'emulator/emulator');
  if (!existsSync(adb))
    throw new Error(
      'Android SDK missing. Install Android Studio or set ANDROID_HOME.',
    );
  const devices = () =>
    capture(adb, ['devices'])
      .split('\n')
      .filter((line) => /^emulator-\d+\s+device$/.test(line))
      .map((line) => line.split(/\s+/)[0]);
  let serial = env.ANDROID_SERIAL ?? devices()[0];
  if (!serial) {
    const avds = capture(emulator, ['-list-avds']).split('\n').filter(Boolean);
    const avd = env.ANDROID_AVD ?? avds[0];
    if (!avd || !avds.includes(avd))
      throw new Error(
        'No matching Android AVD. Create one in Android Studio or set ANDROID_AVD.',
      );
    console.log(`[android] Booting ${avd}`);
    background(emulator, ['-avd', avd], 'emulator.log');
    for (let attempt = 0; attempt < 180 && !serial; attempt++) {
      serial = devices()[0];
      if (!serial) await delay(1000);
    }
  }
  if (!serial || !devices().includes(serial))
    throw new Error(
      'Android emulator unavailable. Check emulator.log / ANDROID_SERIAL.',
    );
  let booted = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (
      capture(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) ===
      '1'
    ) {
      booted = true;
      break;
    }
    await delay(1000);
  }
  if (!booted) throw new Error('Android boot timed out.');
  await ensureMetro();
  await run(adb, ['-s', serial, 'reverse', 'tcp:8081', 'tcp:8081']);
  // Local MinIO presigned URLs use 127.0.0.1; keep their original signed host.
  await run(adb, ['-s', serial, 'reverse', 'tcp:59000', 'tcp:59000']);
  await run('pnpm', [
    '--filter',
    'mobile',
    'exec',
    'expo',
    'prebuild',
    '--platform',
    'android',
    '--no-install',
  ]);
  const abi = capture(adb, [
    '-s',
    serial,
    'shell',
    'getprop',
    'ro.product.cpu.abi',
  ]);
  await run(
    './gradlew',
    [
      'app:assembleDebug',
      '-x',
      'lint',
      '-x',
      'test',
      '--build-cache',
      '-PreactNativeDevServerPort=8081',
      `-PreactNativeArchitectures=${abi}`,
    ],
    { cwd: join(mobile, 'android') },
  );
  await run(adb, [
    '-s',
    serial,
    'install',
    '-r',
    join(mobile, 'android/app/build/outputs/apk/debug/app-debug.apk'),
  ]);
  await run(adb, ['-s', serial, 'shell', 'am', 'force-stop', 'ai.keen.mobile']);
  await run(adb, [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-n',
    'ai.keen.mobile/.MainActivity',
  ]);
  console.log(
    '[android] APK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk',
  );
}
async function ios() {
  if (process.platform !== 'darwin')
    throw new Error('iOS simulators require macOS and Xcode.');
  const developer = capture('xcode-select', ['-p']);
  const list = JSON.parse(
    capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json']),
  );
  const devices = Object.entries(list.devices)
    .filter(([runtime]) => runtime.includes('.iOS-'))
    .flatMap(([, items]) => items)
    .filter((device) => device.isAvailable);
  const choice = env.IOS_SIMULATOR;
  const device = choice
    ? devices.find((d) => d.udid === choice || d.name === choice)
    : (devices.find((d) => d.state === 'Booted') ??
      devices.find((d) => d.name.startsWith('iPhone')));
  if (!device)
    throw new Error(
      'No matching iOS simulator. Install an iOS runtime in Xcode or set IOS_SIMULATOR.',
    );
  if (device.state !== 'Booted')
    await run('xcrun', ['simctl', 'boot', device.udid]);
  await run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  const viewers = [
    join(developer, 'Applications/Simulator.app'),
    join(dirname(developer), 'Applications/Simulator.app'),
    join(dirname(developer), 'Applications/DeviceHub.app'),
  ];
  const viewer = viewers.find(existsSync);
  if (viewer) await run('open', [viewer]);
  await ensureMetro();
  await run('pnpm', [
    '--filter',
    'mobile',
    'exec',
    'expo',
    'prebuild',
    '--platform',
    'ios',
    '--no-install',
  ]);
  await run('pod', ['install'], { cwd: join(mobile, 'ios') });
  const build = join(cache, 'ios-build');
  const logfile = join(cache, 'ios-build.log');
  const fd = openSync(logfile, 'w');
  console.log(`[ios] Building ${device.name}; log: ${logfile}`);
  try {
    await run(
      'xcodebuild',
      [
        '-workspace',
        join(mobile, 'ios/KeenAI.xcworkspace'),
        '-scheme',
        'KeenAI',
        '-configuration',
        'Debug',
        '-destination',
        `id=${device.udid}`,
        '-derivedDataPath',
        build,
      ],
      { stdio: ['ignore', fd, fd] },
    );
  } catch (error) {
    console.error(
      readFileSync(logfile, 'utf8').split('\n').slice(-35).join('\n'),
    );
    throw error;
  } finally {
    closeSync(fd);
  }
  const app = join(build, 'Build/Products/Debug-iphonesimulator/KeenAI.app');
  await run('xcrun', ['simctl', 'install', device.udid, app]);
  // Stop an old process so the newly installed native binary is used.
  spawnSync('xcrun', ['simctl', 'terminate', device.udid, 'ai.keen.mobile'], {
    stdio: 'ignore',
  });
  await run('xcrun', ['simctl', 'launch', device.udid, 'ai.keen.mobile']);
  console.log(`[ios] App: ${app}`);
}
try {
  if (!existsSync(join(mobile, 'node_modules/expo')))
    throw new Error('Run pnpm install first.');
  if (target === 'android' || target === 'all') await android();
  if (target === 'ios' || target === 'all') await ios();
  console.log(
    '[mobile] Done. API addresses: Android http://10.0.2.2:8002; iOS http://127.0.0.1:8002.',
  );
} catch (error) {
  console.error(`[mobile] ${error.message}`);
  process.exitCode = 1;
}
