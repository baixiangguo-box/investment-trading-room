import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flags = args.filter(arg => arg.startsWith('--'));
const scripts = args.filter(arg => !arg.startsWith('--'));
if (!scripts.length) throw new Error('请指定一个或多个 scripts/*-qa.mjs。');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if (flags.includes('--offline')) environment.TRADING_QA_OFFLINE = '1';
for (const script of scripts) {
  if (!/^scripts\/[a-z-]+-qa\.mjs$/.test(script)) throw new Error('只能运行项目自身的桌面验收脚本。');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(root, script), ...flags.filter(flag => flag !== '--offline')], { cwd: root, env: environment, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${script} 超过五分钟，停止验收。`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (status, signal) => { clearTimeout(timeout); if (signal) reject(new Error(`${script} 被信号 ${signal} 中止。`)); else resolve(status ?? 1); });
  });
  if (code !== 0) process.exit(code);
}
