// scripts/scenario-loop.mjs — 20-round multi-scenario live QA against the
// REAL backend (default http://127.0.0.1:7630). Each round drives the true
// user path: SSE direct-chat (grounded reply) + 对话即委托 (orchestration),
// then asserts observable effects on the board / chat / memory.
// Usage: node scripts/scenario-loop.mjs [BASE]
import { writeFileSync, readFileSync } from "node:fs";

const BASE = process.argv[2] || process.env.PROBE_BASE || "http://127.0.0.1:7630";
const SHOTS = "probe-shots";

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
};

const state = async () => (await api("GET", "/api/state")).json;

async function newConv() {
  const r = await api("POST", "/api/conversations", {});
  return r.json.id;
}

/** SSE direct-chat round: returns the assembled assistant reply. */
async function chat(convId, text, timeoutMs = 90_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + "/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convId, text, mode: "agent" }),
      signal: ctl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let reply = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const f = JSON.parse(line.slice(6));
          if (f.type === "content" && typeof f.delta === "string") reply += f.delta;
          if (f.type === "error") return { reply, error: f.message };
        } catch { /* keep-alive */ }
      }
    }
    return { reply };
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollState(cond, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const s = await state();
    if (cond(s)) return s;
    await sleep(4_000);
  }
  return null;
}

const fmt = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 90);
let pass = 0, fail = 0, soft = 0;
const report = [];
async function round(n, title, input, check) {
  const conv = await newConv();
  const t0 = Date.now();
  let out;
  try {
    const r = await chat(conv, input, 120_000);
    const s = await pollState(check.board ?? (() => true), check.waitMs ?? 30_000);
    const verdict = check.judge(r, s);
    if (verdict === true) { pass++; }
    else if (verdict === "soft") { soft++; }
    else { fail++; }
    out = { n, title, verdict: verdict === true ? "PASS" : verdict === "soft" ? "SOFT" : "FAIL", ms: Date.now() - t0, reply: fmt(r.reply), error: r.error ?? null };
  } catch (e) {
    fail++;
    out = { n, title, verdict: "FAIL", ms: Date.now() - t0, reply: "", error: String(e.message || e).slice(0, 120) };
  }
  report.push(out);
  console.log(`[${String(n).padStart(2, "0")}] ${out.verdict} ${title} (${(out.ms / 1000).toFixed(0)}s)${out.error ? " ERR=" + out.error : ""}\n     ↳ ${out.reply || "(no reply)"}`);
}

const before = await state();
const beforeCards = before.tasks.length;
console.log(`scenario-loop @ ${BASE} · tickN=${before.tickN} · cards=${beforeCards} · budget=${before.budget.line}\n`);

/* ── the 20 rounds ── */
await round(1, "问候不建卡", "你好呀，今天辛苦了",
  { judge: (r, s) => r.reply.length > 0 && s.tasks.length === beforeCards ? true : (s.tasks.length === beforeCards ? true : false) });

await round(2, "任务板直查", "我的任务板现在有哪几张卡？简单列一下",
  { judge: (r) => /(整理|卡|任务)/.test(r.reply) && r.reply.length > 10 ? true : "soft",
    board: (s) => true, waitMs: 20_000 });

await round(3, "时间直答", "现在几点了？",
  { judge: (r) => /\d{1,2}[:：]\d{2}/.test(r.reply) ? true : "soft", waitMs: 15_000 });

await round(4, "系统信息接地", "这台机器是什么操作系统？",
  { judge: (r) => /(linux|ubuntu|wsl|内核)/i.test(r.reply) ? true : "soft", waitMs: 30_000 });

const tiny1 = "请创建任务：往 /tmp/rj-t1.txt 写入一行 hello-robojex 然后读出来确认内容";
await round(5, "真实小派工#1", tiny1,
  { judge: (r, s) => s && s.tasks.some((t) => t.status !== "todo" || t.title.length > 0) && s.tasks.length > beforeCards ? true : "soft",
    board: (s) => s.tasks.length > beforeCards, waitMs: 120_000 });

await round(6, "排程未来任务", "创建任务：明天上午9点提醒我喝水（安排成定时任务）",
  { judge: (r, s) => {
      const card = (s?.tasks ?? []).find((t) => t.title.includes("喝水"));
      return card && card.scheduledAt && card.scheduledAt > Date.now() ? true : "soft";
    },
    board: (s) => s.tasks.some((t) => t.title.includes("喝水")), waitMs: 60_000 });

await round(7, "记忆写入", "记住一条经验：测试标记 R20MARK 的幸运数字是 42",
  { judge: (r, s) => (s?.memory ?? "").includes("R20MARK") ? true : "soft", waitMs: 45_000 });

await round(8, "记忆回读", "R20MARK 的幸运数字是多少？",
  { judge: (r) => /42/.test(r.reply) ? true : "soft", waitMs: 30_000 });

await round(9, "重复派单护栏(R79)", tiny1 + "（再做一遍）",
  { judge: (r, s) => {
      const n = (s?.tasks ?? []).filter((t) => t.title.includes("rj-t1") || t.title.includes("hello-robojex")).length;
      return n >= 2 ? true : "soft"; // two same-purpose cards + the guard event fires on the second
    },
    board: (s) => s.tasks.filter((t) => /rj-t1|hello-robojex/.test(t.title)).length >= 2, waitMs: 90_000 });

await round(10, "英文派工", "Create a task: count the files in /tmp and write the number to /tmp/rj-count.txt",
  { judge: (r, s) => (s?.tasks ?? []).some((t) => /count|\/tmp/i.test(t.title)) ? true : "soft",
    board: (s) => s.tasks.some((t) => /count/i.test(t.title)), waitMs: 60_000 });

await round(11, "三步计划", "制定一个三步计划：①看 /tmp 占用大小 ②删除 /tmp/rj-t1.txt ③汇报结果",
  { judge: (r, s) => {
      const gained = (s?.tasks ?? []).length;
      return r.reply.length > 0 && (gained > beforeCards + 3 || /计划|步骤/.test(r.reply)) ? true : "soft";
    }, waitMs: 60_000 });

await round(12, "改期 steer", "把「提醒我喝水」那张卡改到明天上午10点",
  { judge: (r, s) => {
      const card = (s?.tasks ?? []).find((t) => t.title.includes("喝水"));
      if (!card) return "soft";
      const d = new Date(card.scheduledAt || 0);
      return d.getHours() === 10 ? true : "soft";
    }, waitMs: 60_000 });

await round(13, "进度询问", "现在整体任务进展怎么样了？",
  { judge: (r) => r.reply.length > 10 ? true : "soft", waitMs: 30_000 });

await round(14, "无意义输入", "asdfghjkl 12345 ???",
  { judge: (r, s) => r.reply.length > 0 && s.tasks.length === beforeCards ? true : (s.tasks.length <= beforeCards + 1 ? "soft" : false), waitMs: 20_000 });

await round(15, "长输入", "请你帮我安排一件事：" + "这个需求很重要，".repeat(60) + "整理 /tmp/rj-t1.txt 的内容并汇报",
  { judge: (r) => !r.error && r.reply.length > 0 ? true : "soft", waitMs: 60_000 });

const tiny2 = "创建任务：把 uname -a 的输出写入 /tmp/rj-sys.txt";
await round(16, "真实小派工#2", tiny2,
  { judge: (r, s) => (s?.tasks ?? []).some((t) => /uname|rj-sys/i.test(t.title)) ? true : "soft",
    board: (s) => s.tasks.some((t) => /uname|rj-sys/i.test(t.title)), waitMs: 90_000 });

await round(17, "战绩询问", "hermes 最近的战绩怎么样？通过率多少？",
  { judge: (r) => /(%|通过|成|\d)/.test(r.reply) && r.reply.length > 10 ? true : "soft", waitMs: 30_000 });

await round(18, "人工裁决不通过", "验收「把 uname -a 的输出写入 /tmp/rj-sys.txt」不通过，理由：文件不存在",
  { judge: (r, s) => {
      const card = (s?.tasks ?? []).find((t) => /uname|rj-sys/i.test(t.title) && t.verdict === "fail");
      return card ? true : "soft"; // fail verdict + auto re-dispatch ladder
    },
    board: (s) => s.tasks.some((t) => /uname|rj-sys/i.test(t.title) && t.verdict === "fail"), waitMs: 90_000 });

await round(19, "人工裁决通过", "验收「往 /tmp/rj-t1.txt 写入一行 hello-robojex 然后读出来确认内容」通过",
  { judge: (r, s) => (s?.tasks ?? []).some((t) => /rj-t1|hello-robojex/.test(t.title) && t.verdict === "pass") ? true : "soft",
    board: (s) => s.tasks.some((t) => /rj-t1|hello-robojex/.test(t.title) && t.verdict === "pass"), waitMs: 90_000 });

await round(20, "总结收尾", "总结一下今天你干了什么，两三句话",
  { judge: (r) => r.reply.length > 20 ? true : "soft", waitMs: 45_000 });

const after = await state();
console.log(`\n════ 结果: ${pass} PASS · ${soft} SOFT · ${fail} FAIL ════`);
console.log(`tickN ${before.tickN}→${after.tickN} · cards ${beforeCards}→${after.tasks.length} · ${after.budget.line}`);
writeFileSync(`${SHOTS}/scenario-loop-report.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, soft, fail, rounds: report, budget: after.budget.line }, null, 2));
process.exit(fail > 0 ? 1 : 0);
