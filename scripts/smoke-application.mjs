// Launch the actual distributed executable twice, with a disposable account.
// This checks startup/persistence/normal quit, not physical Mac user acceptance.
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createAccountService } from '../core/account-service.mjs';
import { packagedPaths, defaultApplicationRoot } from './package-paths.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const application = packagedPaths(process.argv[2] || defaultApplicationRoot(root));
const directory = path.join(root, '.qa', `binary-smoke-${Date.now()}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--standalone')) {
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  env.PATH = application.mac ? '/usr/bin:/bin:/usr/sbin:/sbin' : `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
}
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runOnce() {
  const child = spawn(application.executable, [`--data-dir=${directory}`], { env, stdio: 'ignore' });
  let exited = false, result, failure;
  child.once('error', error => { failure = error; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; result = { code, signal }; resolve(result); }));
  const started = Date.now(); let ready;
  try {
    while (Date.now() - started < 45000) {
      if (failure) throw failure;
      if (exited) throw new Error(`Application exited before readiness: ${JSON.stringify(result)}`);
      try { const event = JSON.parse(await readFile(path.join(directory, 'logs', 'latest-event.json'), 'utf8'));
        if (event.kind === 'ready' && event.detail.process === child.pid && event.detail.version === version) { ready = event; break; }
      } catch { /* Wait for complete diagnostic write. */ }
      await pause(80);
    }
    assert(ready, 'Actual application never reported loaded renderer');
    const close = application.mac
      ? spawn('/usr/bin/osascript', ['-e', `tell application "${application.root.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" to quit`], { stdio: 'inherit' })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$taskApp=Get-Process -Id ${child.pid} -ErrorAction Stop; if(-not $taskApp.CloseMainWindow()){throw 'Owned test window did not accept close'} `], { stdio: 'inherit', windowsHide: true });
    await new Promise((resolve, reject) => { close.once('error', reject); close.once('exit', code => code === 0 ? resolve() : reject(new Error(`Normal quit command failed: ${code}`))); });
    const outcome = await Promise.race([exit, pause(20000).then(() => { throw new Error('Application failed to exit normally'); })]);
    assert.equal(outcome.signal, null); assert.equal(outcome.code, 0);
  } finally { if (!exited) child.kill(); }
}
await runOnce();
const factory = () => createAccountService({ dbPath: path.join(directory, 'account.sqlite'), quoteProvider: async () => [] });
let service = factory(); let account;
try { assert.equal(service.getAccount().initialized, false); account = service.setup({ nickname: '安装包二次启动测试', initial: 12345.67 }); account = service.watch({ symbol: 'sz000001', generation: account.generation }); } finally { await service.close(); }
await runOnce();
service = factory();
try { const reread = service.getAccount(); assert.equal(reread.nickname, account.nickname); assert.equal(reread.totalCash, 12345.67); assert.deepEqual(reread.watchlist, ['sz000001']); assert(service.diagnostics().ok); }
finally { await service.close(); }
console.log(JSON.stringify({ ok: true, version, platform: process.platform, arch: process.arch, actualExecutable: true, starts: 2, normalQuit: true, sqliteReopen: true, isolatedProfile: true, manualMacAcceptance: false }));
