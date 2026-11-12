#!/usr/bin/env node
/**
 * 一键打包 Lenovo xPaas 部署包（方案 A：本地构建产物随包上传）。
 *
 *   npm run pack:xpaas
 *
 * 产出 deploy/xpaas-package/（可直接上传的目录内容）与 deploy/ai-todo-xpaas.zip。
 * 包内容：package.json、package-lock.json、dist/（后端编译产物）、
 *        frontend/dist/（前端构建产物）、Dockerfile（平台模板改造版）。
 *
 * 平台容器里：npm install --omit=dev → npm start（= node dist/src/cli.js serve）。
 * 数据库走平台注入的 DATABASE_URL 环境变量，容器内不落库文件。
 */
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'deploy', 'xpaas-package');
const zipPath = join(root, 'deploy', 'ai-todo-xpaas.zip');

const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`✗ 命令失败：${cmd} ${args.join(' ')}（exit ${r.status}）`);
    process.exit(1);
  }
};

console.log('1/4 清理旧的打包产物');
rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });

console.log('2/4 构建后端（tsc）与前端（vite build）');
run('npm', ['run', 'build']);
run('npm', ['run', 'web:build']);

console.log('3/4 组装部署包');
mkdirSync(outDir, { recursive: true });
const mustCopy = (src, dest) => {
  if (!existsSync(src)) {
    console.error(`✗ 缺少必需文件：${src}`);
    process.exit(1);
  }
  cpSync(src, dest, typeof dest === 'string' && !statSync(src).isDirectory() ? undefined : { recursive: true });
  console.log(`   + ${dest === src ? src : `${src} → ${dest}`}`);
};
mustCopy(join(root, 'package.json'), join(outDir, 'package.json'));
mustCopy(join(root, 'package-lock.json'), join(outDir, 'package-lock.json'));
mustCopy(join(root, 'dist'), join(outDir, 'dist'));
mustCopy(join(root, 'frontend', 'dist'), join(outDir, 'frontend', 'dist'));
mustCopy(join(root, 'deploy', 'Dockerfile.xpaas'), join(outDir, 'Dockerfile'));

console.log('4/4 压缩 zip');
let zipped = false;
if (process.platform === 'win32') {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path (Join-Path '${outDir.replaceAll("'", "''")}' '*') -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit', shell: true },
  );
  zipped = r.status === 0;
} else {
  const r = spawnSync('zip', ['-rq', zipPath, '.'], { stdio: 'inherit', cwd: outDir });
  zipped = r.status === 0;
}

const sizeOf = (p) => {
  const st = statSync(p);
  if (st.isFile()) return st.size;
  let n = 0;
  for (const f of readdirSync(p, { withFileTypes: true })) {
    n += sizeOf(join(p, f.name));
  }
  return n;
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log('');
console.log('打包完成：');
console.log(`  目录：${outDir}（${mb(sizeOf(outDir))}）`);
if (zipped) console.log(`  压缩：${zipPath}（${mb(statSync(zipPath).size)}）`);
else console.log('  压缩：系统没有可用的压缩命令，请手动压缩目录内容');
console.log('');
console.log('上传平台前确认：');
console.log('  - 平台环境变量已配置 DATABASE_URL（外部 Postgres）');
console.log('  - 如需邮件通知，配置 AI_TODO_SMTP_* 系列变量');
console.log('  - 建议配置 AI_TODO_BASE_URL 为外网访问地址（邮件里的任务链接用它）');
