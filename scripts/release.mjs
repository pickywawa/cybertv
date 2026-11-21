#!/usr/bin/env node
/**
 * Builds a release and its self-update manifest.
 *
 *   npm run release -- [--native] [--publish] [--notes "text"]
 *
 * --native   the Android side changed: bump versionCode and require this APK for the new web bundle
 *            (without it, installed apps update their web content silently)
 * --publish  create the GitHub release (gh CLI) with the APK, the web zip and update.json
 * --desktop  also build the desktop app (Electron): macOS dmg (arm64 + x64), Windows installer, Linux AppImage
 * --ios      also build an unsigned iOS .ipa (to sideload: AltStore, Sideloadly… re-sign it with an Apple ID)
 * --notes-file <path>  release notes from a Markdown file
 *
 * Outputs release/CyberIPTV-<v>.apk, release/web-<v>.zip, release/update.json
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const extra = [];

// ── desktop (Electron) ──
if (flag('--desktop')) {
  rmSync(join(out, 'desktop'), { recursive: true, force: true });
  run('npm run desktop:build-main');
  run('npx electron-builder --mac --win --linux --publish never -c.directories.output=release/desktop', root, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  for (const f of readdirSync(join(out, 'desktop'))) if (/\.(dmg|exe|AppImage)$/.test(f)) extra.push(join(out, 'desktop', f));
}

// ── iOS (unsigned) ──
if (flag('--ios')) {
  run('npx cap sync ios');
  // same version on iOS as everywhere else
  const pbx = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8')
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`),
  );
  const dd = join(root, 'build', 'ios-release');
  run(
    `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos -destination generic/platform=iOS ` +
      `-derivedDataPath ${JSON.stringify(dd)} CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build -quiet`,
  );
  const payload = join(dd, 'Payload');
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload);
  run(`cp -R ${JSON.stringify(join(dd, 'Build/Products/Release-iphoneos/App.app'))} ${JSON.stringify(payload)}/`);
  const ipa = join(out, `CyberIPTV-${version}-ios-unsigned.ipa`);
  run(`zip -qry ${JSON.stringify(ipa)} Payload`, dd);
  extra.push(ipa);
}

// ── manifest ──
const base = `https://github.com/${repo}/releases/download/v${version}`;
const manifest = {
  version,
  versionCode,
  minVersionCode,
  apk: `${base}/${apkName}`,
  web: `${base}/web-${version}.zip`,
  webSha256: sha,
  notes: (opt('--notes-file') ? readFileSync(opt('--notes-file'), 'utf8') : opt('--notes') || '').trim(),
};
writeFileSync(join(out, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\nrelease/ ready:', manifest);

if (flag('--publish')) {
  const notesFile = join(out, 'NOTES.md');
  writeFileSync(notesFile, opt('--notes-file') ? readFileSync(opt('--notes-file'), 'utf8') : opt('--notes') || `CyberIPTV ${version}`);
  run(
    `gh release create v${version} -R ${repo} --target main --title "CyberIPTV ${version}" --notes-file ${JSON.stringify(notesFile)} ` +
      [join(out, apkName), webZip, join(out, 'update.json'), ...extra].map((f) => JSON.stringify(f)).join(' '),
  );
}
