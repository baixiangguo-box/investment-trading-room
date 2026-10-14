import { build, Platform, Arch } from 'electron-builder';
if (process.platform !== 'win32') throw new Error('Windows 一键安装包在 Windows Runner 上构建。');
await build({ publish: 'never', targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: {
  win: { artifactName: 'InvestmentTradingRoom-OneClick-Setup-${version}-${arch}.${ext}' },
  nsis: { oneClick: true, allowToChangeInstallationDirectory: false, runAfterFinish: false },
} });
