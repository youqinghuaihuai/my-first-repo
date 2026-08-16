"use strict";
/**
 * DeepSeek Harness 桌面版 — Electron 壳
 *
 * 启动逻辑：
 *  1. 若 3080 端口上已有 DSH 服务（未显式指定 --port 时），直接复用并打开窗口；
 *  2. 否则用内置的 DSH 运行时（resources/dsh）以 Node 模式启动 `dsh web`；
 *  3. 等服务就绪后把窗口导航到 http://127.0.0.1:<port>/；
 *  4. 关闭窗口即退出；如果是自己启动的服务，退出时连同子进程树一起结束。
 */
const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_PORT = 3080;
const BOOT_TIMEOUT_MS = 90_000;

let mainWindow = null;
let serverProc = null;
let ownsServer = false;
let quitting = false;
let actualUrl = null;      // 从 dsh 输出解析到的真实 URL（支持 --port 0）

/* ---------------- 工具 ---------------- */

function logPath() {
  return path.join(app.getPath("userData"), "dsh-desktop.log");
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  try { fs.appendFileSync(logPath(), line + "\n"); } catch {}
  console.log(line);
}

function parsePortArg() {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && i < process.argv.length - 1) {
    const p = Number(process.argv[i + 1]);
    if (Number.isInteger(p) && p >= 0 && p <= 65535) return p;
  }
  return DEFAULT_PORT;
}

/** 打包后从 process.resourcesPath 找，开发模式从工程目录找。 */
function dshRoot() {
  const candidates = [
    path.join(process.resourcesPath, "dsh"),
    path.join(__dirname, "resources", "dsh"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "node_modules", "@deepseek-ai", "dsh"))) return c;
  }
  return null;
}
function dshBin() {
  const root = dshRoot();
  return root ? path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null;
}
/** 内置的真实 Node 运行时（与 DSH 原生模块 ABI 匹配）；缺失时退回 Electron 的 Node。 */
function dshNodeExe() {
  const root = dshRoot();
  const p = root ? path.join(root, "node", "node.exe") : null;
  return p && fs.existsSync(p) ? p : null;
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
        if (body.length > 65536) req.destroy();
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (actualUrl) {
      const res = await httpGet(actualUrl);
      if (res && res.status === 200) return true;
    }
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    if (res && res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 结束整棵进程树（防止遗留子代理等孤儿进程）。 */
function killServerTree(proc) {
  if (!proc) return;
  try {
    const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    killer.unref();
  } catch {
    try { proc.kill(); } catch {}
  }
}

function startServer(port) {
  const bin = dshBin();
  const root = dshRoot();
  if (!bin || !root) throw new Error("未找到内置的 DSH 运行时 (resources/dsh)");
  const nodeExe = dshNodeExe();
  const program = nodeExe || process.execPath;
  const extraEnv = nodeExe ? {} : { ELECTRON_RUN_AS_NODE: "1" };
  log(`启动内置 DSH 服务: ${program} ${bin} web --port ${port}`);
  const child = spawn(program, [bin, "web", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProc = child;
  ownsServer = true;
  child.stdout.on("data", (c) => {
    const s = c.toString();
    log("[dsh] " + s.trimEnd());
    const m = s.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
    if (m) actualUrl = m[1];
  });
  child.stderr.on("data", (c) => log("[dsh:err] " + c.toString().trimEnd()));
  child.on("exit", (code) => {
    log(`内置 DSH 服务退出, code=${code}`);
    serverProc = null;
    if (!quitting && mainWindow) {
      mainWindow.loadURL(renderErrorPage(`DSH 服务意外退出 (code=${code})\n\n详情见日志: ${logPath()}`));
    }
  });
}

/* ---------------- 页面 ---------------- */

function renderLoadingPage(msg) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:"Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
.spin{width:42px;height:42px;border:4px solid #2f81f7;border-top-color:transparent;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}p{margin-top:22px;font-size:15px;max-width:70%;text-align:center;line-height:1.6}</style>
</head><body><div class="spin"></div><p>${msg}</p></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function renderErrorPage(msg) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness - 启动失败</title>
<style>body{background:#0d1117;color:#f85149;font-family:"Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
h1{font-size:20px}p{margin:14px 60px;font-size:14px;white-space:pre-wrap;text-align:center;line-height:1.7;color:#c9d1d9}</style>
</head><body><h1>⚠ 启动失败</h1><p>${msg}</p></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "DeepSeek Harness",
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { mainWindow = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}

/* ---------------- 启动 ---------------- */

async function boot() {
  app.setAppUserModelId("ai.deepseek.harness.desktop");
  Menu.setApplicationMenu(null);
  const port = parsePortArg();
  const explicitPort = process.argv.includes("--port");

  mainWindow = createWindow();
  await mainWindow.loadURL(renderLoadingPage("正在启动 DeepSeek Harness …"));

  let target = null;

  // 1) 未指定端口且默认端口已有 DSH 服务 → 直接复用
  if (!explicitPort && port === DEFAULT_PORT) {
    const existing = await httpGet(`http://127.0.0.1:${port}/`);
    if (existing && existing.status === 200) {
      log(`检测到 ${port} 端口已有 DSH 服务，直接复用`);
      target = `http://127.0.0.1:${port}/`;
    }
  }

  // 2) 否则启动内置服务
  if (!target) {
    try {
      startServer(port);
    } catch (e) {
      log("启动失败: " + e.message);
      target = "error:" + e.message;
    }
  }
  if (!target) {
    const ok = await waitForServer(port, BOOT_TIMEOUT_MS);
    target = ok ? (actualUrl || `http://127.0.0.1:${port}/`) : "error:启动超时（90 秒内服务未就绪）";
  }

  if (target.startsWith("error:")) {
    await mainWindow.loadURL(renderErrorPage(target.slice(6) + `\n\n日志文件: ${logPath()}`));
  } else {
    await mainWindow.loadURL(target);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
}

/* ---------------- 退出 ---------------- */

app.on("window-all-closed", () => {
  app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  if (ownsServer && serverProc) killServerTree(serverProc);
});
app.on("quit", () => {
  quitting = true;
  if (ownsServer && serverProc) killServerTree(serverProc);
});
