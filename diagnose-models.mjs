/**
 * 诊断：模型变更时网关的行为
 * 1. 上游现在有哪些 -free 模型
 * 2. 网关暴露哪些
 * 3. 差集是什么（网关漏掉了哪些）
 * 4. 每个暴露的模型是否真的能调通
 * 5. 已下架模型调用会怎样
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(HERE, "config.json"), "utf8"));
const BASE = `http://${cfg.listen}`;
const KEY = cfg.apiKey;

// 上游实时列表
const live = await (await fetch("https://opencode.ai/zen/v1/models", {
  headers: { authorization: "Bearer public", "user-agent": "opencode/1.18.31 (win32 x64; node24.14.0)", "x-opencode-client": "cli" },
})).json();
const liveIds = live.data.map((m) => m.id);
const liveFree = liveIds.filter((id) => /free/i.test(id));

// 网关列表
const gw = (await (await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json()).data.map((m) => m.id);

console.log("上游模型总数      :", liveIds.length);
console.log("上游含 free 的    :", liveFree.length);
console.log("网关暴露          :", gw.length);
console.log();

console.log("── 上游有 free、网关没有（网关漏掉的）──");
const missing = liveFree.filter((id) => !gw.includes(id));
if (missing.length === 0) console.log("  （无）");
else missing.forEach((id) => console.log("  ✗", id));
console.log();

console.log("── 网关有、上游 free 列表没有的（可能已下架）──");
const stale = gw.filter((id) => !liveIds.includes(id));
if (stale.length === 0) console.log("  （无，全部仍在上游）");
else stale.forEach((id) => console.log("  ⚠", id));
console.log();

console.log("── 逐个实测网关暴露的模型能否真出字 ──");
for (const id of gw) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: id, stream: false, messages: [{ role: "user", content: "say OK" }] }),
    });
    const txt = await r.text();
    let content = "";
    let err = "";
    try {
      const j = JSON.parse(txt);
      if (j.error) err = j.error.message?.slice(0, 90) ?? "unknown";
      else content = j.choices?.[0]?.message?.content ?? "";
    } catch { err = txt.slice(0, 90); }
    const ms = Date.now() - t0;
    if (r.status === 200 && content) console.log(`  ✅ ${id.padEnd(34)} ${String(ms).padStart(6)}ms  "${content.slice(0, 30)}"`);
    else console.log(`  ❌ ${id.padEnd(34)} ${String(ms).padStart(6)}ms  HTTP ${r.status} ${err}`);
  } catch (e) {
    console.log(`  ❌ ${id.padEnd(34)} 异常 ${e.message.slice(0, 80)}`);
  }
}

console.log();
console.log("── 调用一个上游已不存在的模型 ──");
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "definitely-not-a-real-model-free", stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  const txt = await r.text();
  console.log("  HTTP", r.status, "→", txt.slice(0, 300));
}

console.log();
console.log("── 网关 config 里的 defaultModel 是否仍在上游 ──");
console.log(`  defaultModel = ${cfg.defaultModel}  →  ${liveIds.includes(cfg.defaultModel) ? "✅ 仍在上游" : "❌ 已下架（需要改配置！）"}`);
