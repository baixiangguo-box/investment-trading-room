import path from 'node:path';

export function packagedPaths(applicationRoot) {
  const root = path.resolve(applicationRoot), mac = root.endsWith('.app');
  const resources = path.join(root, ...(mac ? ['Contents', 'Resources'] : ['resources']));
  return { root, mac, resources, archive: path.join(resources, 'app.asar'),
    executable: path.join(root, ...(mac ? ['Contents', 'MacOS', '投资交易室'] : ['投资交易室.exe'])),
    notices: mac ? resources : root };
}

export function defaultApplicationRoot(root, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return path.join(root, 'release', 'win-unpacked');
  if (platform === 'darwin') {
    if (arch !== 'arm64') throw new Error('本版本只提供 Apple Silicon（arm64）Mac 安装包。');
    return path.join(root, 'release', 'mac-arm64', '投资交易室.app');
  }
  throw new Error('安装包核验支持 Windows 与 macOS。');
}
