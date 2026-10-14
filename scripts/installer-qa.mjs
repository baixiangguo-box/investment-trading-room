// Only GitHub-hosted disposable machines may perform actual system installation.
// Never install/update the developer's real application or personal account here.
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('原生安装验收只允许 GitHub 托管隔离 Runner；禁止在个人安装环境执行。');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const mac=process.platform==='darwin';
const installed=mac?'/Applications/投资交易室.app':path.join(root,'.qa',`installed-${randomUUID()}`);
async function run(executable,args){
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Installer QA command exceeded three minutes'));},180000);
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('exit',(code,signal)=>{clearTimeout(timer);code===0&&!signal?resolve():reject(new Error(`Installer QA failed: ${code} ${signal||''}`))});
  });
}
assert.equal(await stat(installed).then(()=>true, e=>{if(e.code==='ENOENT')return false;throw e}),false,'Never overwrite an existing application');
if(mac){
  await run('/usr/bin/sudo',['/usr/sbin/installer','-pkg',path.join(root,'release',`InvestmentTradingRoom-Mac-${version}-${process.arch}.pkg`),'-target','/']);
  await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
  const paths=(await import('./package-paths.mjs')).packagedPaths(installed);
  await run('/usr/bin/otool',['-L',paths.executable]);
}else{
  assert.equal(process.platform,'win32');
  await run(path.join(root,'release',`InvestmentTradingRoom-OneClick-Setup-${version}-x64.exe`),['/S',`/D=${installed}`]);
  // Check PE import tables for a Visual C++ redistributable prerequisite. The
  // runtime may use Windows OS DLLs; redistributable DLLs must ship in the app.
  const binaries=[];
  async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())await walk(file);else if(/\.(exe|dll)$/i.test(item.name))binaries.push(file);}}
  await walk(installed);
  const names=new Set(binaries.map(file=>path.basename(file).toLowerCase()));
  for(const file of binaries){
    const bytes=await readFile(file), pe=bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString('ascii',pe,pe+4),'PE\0\0');
    const optional=pe+24, magic=bytes.readUInt16LE(optional), count=bytes.readUInt16LE(pe+6), sections=optional+bytes.readUInt16LE(pe+20);
    assert([0x10b,0x20b].includes(magic));
    const offset=rva=>{for(let i=0;i<count;i++){const s=sections+i*40,base=bytes.readUInt32LE(s+12),size=Math.max(bytes.readUInt32LE(s+8),bytes.readUInt32LE(s+16));if(rva>=base&&rva<base+size)return bytes.readUInt32LE(s+20)+rva-base;}throw new Error('Invalid import RVA');};
    const directories=optional+(magic===0x20b?112:96);
    for(const [index,stride,namePosition] of [[1,20,12],[13,32,4]]){
      const rva=bytes.readUInt32LE(directories+index*8);if(!rva)continue;
      for(let at=offset(rva);bytes.readUInt32LE(at+namePosition);at+=stride){
        const nameAt=offset(bytes.readUInt32LE(at+namePosition)),end=bytes.indexOf(0,nameAt);assert(end>=nameAt);
        const name=bytes.toString('ascii',nameAt,end).toLowerCase();
        if(/^(?:vcruntime|msvcp|msvcr|concrt|mfc|vcomp|atl)\d.*\.dll$/.test(name))assert(names.has(name),`External redistributable required: ${name} (${file})`);
      }
    }
  }
  console.log(JSON.stringify({windowsPeBinaries:binaries.length,externalVisualCRuntimeRequired:false}));
}
await run(process.execPath,['scripts/verify-package.mjs',installed,`--arch=${process.arch}`]);
await run(process.execPath,['scripts/smoke-application.mjs',installed,'--standalone']);
await mkdir(path.join(root,'.qa'),{recursive:true});
console.log(JSON.stringify({ok:true,actualInstaller:true,platform:process.platform,arch:process.arch,appPath:installed,developerToolsRemovedFromAppPath:true,manualGuiInstallerAcceptance:false}));
