#!/usr/bin/env node
/**
 * watchdog.mjs — OpenGate 守护进程（开机自启的真正入口）
 *
 * 为什么需要它：
 *   原来的 `start-hidden.vbs` 用 `sh.Run "node server.mjs", 0, False` 启动 ——
 *   窗口隐藏、不等候、**stdout/stderr 全部丢弃**。后果：
 *     · 服务崩了没人知道，也不会自动重启
 *     · 用户说"去日志看"时，磁盘上根本没有任何日志
 *     · 无法判断开机自启到底有没有生效
 *
 * 这个守护进程解决三件事：
 *   1. 把子进程的 stdout/stderr 全部落到 `logs/opengate.log`（按大小轮转）
 *   2. 子进程意外退出时自动重启（指数退避，稳定运行后重置计数）
 *   3. 启动时记录"开机后第几秒"——**一眼就能看出是开机自启还是手动启动**
 *
 * 用法：
 *   node watchdog.mjs          正常守护（由 start-hidden.vbs 调用）
 *   node watchdog.mjs --once   只跑一次，崩了不重启（前台调试用）
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
const LOG_DIR = join(HERE, "logs");
const LOG_FILE = join(LOG_DIR, "opengate.log");
const ONCE = process.argv.includes("--once");

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 单个日志文件上限
const KEEP_LOGS = 3;                   // 保留 opengate.log / .1 / .2
const STABLE_MS = 60_000;              // 稳定运行超过这个时长就重置失败计数
const MAX_BACKOFF_MS = 60_000;         // 重启退避上限

/** 带大小轮转的日志写入器。 */
class Logger {
  constructor(file, { maxBytes = MAX_LOG_BYTES, keep = KEEP_LOGS } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.stream = null;
    this.size = 0;
    this._open();
  }

  _open() {
    try {
      this.size = existsSync(this.file) ? statSync(this.file).size : 0;
    } catch {
      this.size = 0;
    }
    this.stream = createWriteStream(this.file, { flags: "a" });
    // 日志写失败绝不能拖垮守护进程
    this.stream.on("error", () => {});
  }

  /** opengate.log → .1 → .2，最旧的丢弃。 */
  _rotate() {
    try { this.stream?.end(); } catch { /* ignore */ }
    try {
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (!existsSync(from)) continue;
        if (existsSync(to)) unlinkSync(to);
        renameSync(from, to);
      }
    } catch { /* 轮转失败也要继续写 */ }
    this._open();
  }

  /** 原样写入子进程的输出（不加时间戳，保持上游格式）。 */
  raw(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (this.size + buf.length > this.maxBytes) this._rotate();
    this.size += buf.length;
    try { this.stream.write(buf); } catch { /* ignore */ }
  }

  /** 写守护进程自己的消息，带 ISO 时间戳。 */
  line(msg) {
    this.raw(`[${new Date().toISOString()}] ${msg}\n`);
  }
}

const listen = await readListen();
const [listenHost, listenPort] = listen.split(":");
const probeHost = listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost;

// 单实例保护（幂等自愈入口）：已有实例在跑就静默退出——
// 计划任务每 10 分钟拉起本进程时不刷日志、不叠实例。
if (await portBusy(probeHost, Number(listenPort))) process.exit(0);

mkdirSync(LOG_DIR, { recursive: true });
const log = new Logger(LOG_FILE);

// ── 启动横幅：这几行是排查"开机自启成没成功"的关键证据 ──────────────
const bootTime = new Date(Date.now() - os.uptime() * 1000);
const sinceBoot = Math.round(os.uptime());
log.line("=".repeat(64));
log.line("OpenGate 守护进程启动");
log.line(`  脚本      : ${SERVER}`);
log.line(`  日志      : ${LOG_FILE}`);
log.line(`  系统开机  : ${bootTime.toLocaleString()}`);
log.line(`  本次启动  : ${new Date().toLocaleString()}`);
// <120 秒 = 几乎可以确定是登录时自启拉起的；很大 = 手动启动
log.line(`  开机后第  : ${sinceBoot} 秒${sinceBoot < 120 ? "   ← 开机自启" : "   ← 手动启动"}`);
log.line("=".repeat(64));

/** 读 config.json 里的 listen，决定要探测哪个端口。 */
async function readListen() {
  try {
    const cfg = JSON.parse(await readFile(join(HERE, "config.json"), "utf8"));
    return cfg.listen ?? "127.0.0.1:8787";
  } catch {
    return "127.0.0.1:8787";
  }
}

/** 端口是否已被占用（= 已有实例在跑）。 */
function portBusy(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

let child = null;
let stopping = false;
let fails = 0;

function start() {
  const startedAt = Date.now();
  log.line(`[启动] node server.mjs（第 ${fails + 1} 次尝试）`);

  // 用 process.execPath 而不是裸 `node`：不依赖 PATH，开机环境下更可靠
  child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (d) => { log.raw(d); try { process.stdout.write(d); } catch { /* ignore */ } });
  child.stderr.on("data", (d) => { log.raw(d); try { process.stderr.write(d); } catch { /* ignore */ } });
  child.on("error", (e) => log.line(`[错误] 无法启动子进程: ${e.message}`));

  child.on("exit", (code, signal) => {
    const ranFor = Date.now() - startedAt;
    log.line(`[退出] 退出码=${code ?? "-"}  信号=${signal ?? "-"}  运行了 ${Math.round(ranFor / 1000)} 秒`);
    child = null;

    if (stopping || ONCE) {
      log.line("[结束] 守护进程退出");
      process.exit(code ?? 0);
    }

    // 稳定运行过就重置退避，避免"偶发崩溃"把间隔越拉越长
    if (ranFor > STABLE_MS) fails = 0;
    fails++;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(fails - 1, 6));
    log.line(`[重启] ${Math.round(delay / 1000)} 秒后重试（连续失败 ${fails} 次）`);
    setTimeout(start, delay).unref();
  });
}

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log.line(`[信号] 收到 ${sig}，正在关闭子进程…`);
  try { child?.kill(); } catch { /* ignore */ }
  // 子进程没在 3 秒内退出就自己走，不留僵尸
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
