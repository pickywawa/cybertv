#!/usr/bin/env node
/**
 * Builds a release and its self-update manifest.
 *
 *   npm run release -- [--native] [--publish] [--notes "text"]
 *
 * --native   the Android side changed: bump versionCode and require this APK for the new web bundle
 *            (without it, installed apps update their web content silently)
 * --publish  create the GitHub release (gh CLI) with the APK, the web zip and update.json
 *
 * Outputs release/CyberIPTV-<v>.apk, release/web-<v>.zip, release/update.json
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const root = new URL('..', import.meta.url).pathname;
const run = (cmd, cwd = root, env = {}) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const repo = pkg.cyber.updateUrl.match(/github\.com\/([^/]+\/[^/]+)\//)[1];

// ── Android versions ──
const gradlePath = join(root, 'android/app/build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
let versionCode = parseInt(gradle.match(/versionCode (\d+)/)[1], 10);
if (flag('--native')) {
  versionCode += 1;
  pkg.cyber.minNativeCode = versionCode;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
gradle = gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);
writeFileSync(gradlePath, gradle);
const minVersionCode = pkg.cyber.minNativeCode;
if (minVersionCode > versionCode) throw new Error(`minNativeCode ${minVersionCode} > versionCode ${versionCode}`);

// ── web bundle ──
const out = join(root, 'release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
run('npx vite build');
const webZip = join(out, `web-${version}.zip`);
run(`zip -qrX ${JSON.stringify(webZip)} .`, join(root, 'dist'));
const sha = createHash('sha256').update(readFileSync(webZip)).digest('hex');

// ── APK (signed with android/keystore.properties) ──
run('npx cap sync android');
const jbr = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
run('./gradlew assembleRelease -q', join(root, 'android'), existsSync(jbr) ? { JAVA_HOME: jbr } : {});
const apkName = `CyberIPTV-${version}.apk`;
copyFileSync(join(root, 'android/app/build/outputs/apk/release/app-release.apk'), join(out, apkName));

// ── manifest ──
const base = `https://github.com/${repo}/releases/download/v${version}`;
const manifest = {
  version,
  versionCode,
  minVersionCode,
  apk: `${base}/${apkName}`,
  web: `${base}/web-${version}.zip`,
  webSha256: sha,
  notes: opt('--notes') || '',
};
writeFileSync(join(out, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\nrelease/ ready:', manifest);

if (flag('--publish')) {
  const notesFile = join(out, 'NOTES.md');
  writeFileSync(notesFile, opt('--notes') || `CyberIPTV ${version}`);
  run(
    `gh release create v${version} -R ${repo} --target main --title "CyberIPTV ${version}" --notes-file ${JSON.stringify(notesFile)} ` +
      [join(out, apkName), webZip, join(out, 'update.json')].map((f) => JSON.stringify(f)).join(' '),
  );
}
