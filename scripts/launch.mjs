/**
 * 一键启动器
 *  1. 首次运行时自动安装依赖、构建前端
 *  2. 启动本地服务
 *  3. 自动打开浏览器
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '8787';
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;

const line = '─'.repeat(58);
const log = (...a) => console.log(...a);

function has(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: true });
  return r.status === 0;
}

async function main() {
  // 1. 依赖
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    log(`\n${line}\n  首次运行：正在安装依赖，请稍候…\n${line}`);
    const pm = has('pnpm') ? 'pnpm' : 'npm';
    const r = spawnSync(pm, ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log('\n[×] 依赖安装失败。请确认已联网，然后手动执行：npm install');
      process.exit(1);
    }
  }

  // 2. 前端构建
  const distIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    log(`\n${line}\n  正在构建界面，请稍候…\n${line}`);
    const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const r = spawnSync(process.execPath, [vite, 'build', '--config', path.join(ROOT, 'vite.config.mjs')], {
      cwd: ROOT, stdio: 'inherit',
    });
    if (r.status !== 0) {
      log('\n[×] 界面构建失败。请手动执行：npm run build');
      process.exit(1);
    }
  }

  // 3. 启动服务（与启动器同进程）
  process.env.PORT = PORT;
  await import('../server/index.mjs');

  // 4. 稍等服务就绪后打开浏览器
  if (process.env.VAULT_NO_OPEN) {
    log(`  (已跳过自动打开浏览器) 请访问： ${URL}\n`);
    return;
  }
  setTimeout(() => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', URL], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [URL], { stdio: 'ignore', detached: true }).unref();
      } else {
        spawn('xdg-open', [URL], { stdio: 'ignore', detached: true }).unref();
      }
      log(`  已为你打开浏览器： ${URL}\n`);
    } catch {
      log(`  请手动在浏览器打开： ${URL}\n`);
    }
  }, 800);
}

main().catch((e) => {
  console.error('\n[×] 启动失败：', e.message);
  process.exit(1);
});
