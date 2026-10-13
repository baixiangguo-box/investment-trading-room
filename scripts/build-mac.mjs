import { build, Platform, Arch } from 'electron-builder';

if (process.platform !== 'darwin') throw new Error('DMG 构建及签名必须在 macOS 上执行；Windows 请使用 GitHub Actions。');
const architecture = process.argv[2];
if (architecture !== 'arm64') throw new Error('本版本只提供 Apple Silicon（arm64）Mac 安装包。');
const signed = process.argv.includes('--signed');
if (!signed) {
  // CI/development signatures have no publisher identity. Never use signing
  // credentials in PR builds; this only allows credential-free ad-hoc signing.
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  process.env.CSC_FOR_PULL_REQUEST = 'true';
}
await build({ publish: 'never', targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch[architecture]),
  config: signed ? { forceCodeSigning: true, mac: { notarize: true } }
    : { mac: { identity: '-', notarize: false } } });
console.log(JSON.stringify({ platform: 'darwin', arch: architecture,
  publisherSigning: signed ? 'Developer ID required; inspect actual signature and notarization result' : 'ad-hoc only; not Developer ID signed or notarized' }));
