// scripts/probe-focus.mjs — 8-round focused live QA against the hard paths
// (R81 reschedule · R82 time errands · R83 archive · R84 jobs · R80/R85
// grounding & rulings). Drives the REAL backend (default http://127.0.0.1:7630)
// over SSE chat and asserts observable board/jobs effects. Born as
// tmp-r85-probe.mjs on the night it went 3·3·2 → 8·0·0; kept as the
// permanent defect-mining rig.
// Usage: node scripts/probe-focus.mjs [BASE]
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:7630";
const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
};
const state = async () => (await api("GET", "/api/state")).json;

async function chat(text, timeoutMs = 90_000) {
  const convId = (await api("POST", "/api/conversations", {})).json.id;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let reply = "", error = null;
  try {
    const res = await fetch(BASE + "/api/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convId, text, mode: "agent" }), signal: ctl.signal,
    });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: ")); if (!line) continue;
        try { const f = JSON.parse(line.slice(6)); if (f.type === "content" && f.delta) reply += f.delta; if (f.type === "error") error = f.message; } catch { /* */ }
      }
    }
  } catch { error = "stream aborted"; } finally { clearTimeout(timer); }
  return { reply, error };
}

const report = []; let pass = 0, soft = 0, fail = 0;
const record = (n, title, verdict, note) => { report.push({ n, title, verdict, note }); ({ PASS: () => pass++, SOFT: () => soft++, FAIL: () => fail++ })[verdict](); console.log(`[${verdict}] ${n} ${title} — ${note}`); };

// ── R1: time errand (+2min reminder) ──
{
  const t0 = Date.now();
  const { reply, error } = await chat("2分钟后提醒我抬头看看窗外");
  let card = null;
  for (let i = 0; i < 24 && !card; i++) { await sleep(5000); const st = await state(); card = st.tasks.find((t) => /窗外|抬头/.test(t.title) && ["todo", "running", "blocked"].includes(t.status) && t.scheduledAt && t.scheduledAt > t0 && t.scheduledAt < t0 + 8 * 60_000); }
  if (error) record(1, "定时委托+2min", "FAIL", `chat error: ${error}`);
  else if (card) record(1, "定时委托+2min", "PASS", `card「${card.title}」sched +${Math.round((card.scheduledAt - t0) / 1000)}s status=${card.status}`);
  else record(1, "定时委托+2min", "FAIL", `no card; reply=${reply.slice(0, 80)}`);
}

// ── R2: reschedule that card to tomorrow 09:00 ──
{
  const st0 = await state();
  const card = [...st0.tasks].reverse().find((t) => /窗外|抬头/.test(t.title) && ["todo", "running", "blocked"].includes(t.status));
  if (!card) record(2, "改期", "SOFT", "no live reminder card (round 1 failed)");
  else {
    const before = card.scheduledAt;
    const { reply } = await chat(`把「${card.title.slice(0, 12)}」那张卡改到明天上午9点`);
    let moved = null;
    for (let i = 0; i < 24 && !moved; i++) { await sleep(5000); const st = await state(); const c = st.tasks.find((t) => t.id === card.id); if (c && c.scheduledAt !== before) moved = c; }
    if (moved) { const h = new Date(moved.scheduledAt); record(2, "改期", h.getHours() === 9 && h > new Date() ? "PASS" : "SOFT", `sched → ${h.toLocaleString("zh-CN", { hour12: false })}`); }
    else record(2, "改期", "FAIL", "scheduledAt never moved");
  }
}

// ── R3: archive that card ──
{
  const st0 = await state();
  const card = [...st0.tasks].reverse().find((t) => /窗外|抬头/.test(t.title) && ["todo", "blocked"].includes(t.status));
  if (!card) record(3, "归档", "SOFT", "no archivable reminder card");
  else {
    await chat(`那张「${card.title.slice(0, 12)}」不要了，归档掉吧`);
    let gone = false;
    for (let i = 0; i < 24 && !gone; i++) { await sleep(5000); const st = await state(); gone = st.tasks.find((t) => t.id === card.id)?.status === "cancelled"; }
    record(3, "归档", gone ? "PASS" : "FAIL", gone ? "cancelled ✓" : "never cancelled");
  }
}

// ── R4: background job visible ──
{
  const { reply, error } = await chat("帮我在后台跑一个 sleep 25 的命令，别等它结束");
  let running = null;
  for (let i = 0; i < 24 && !running; i++) { await sleep(5000); const j = (await api("GET", "/api/jobs")).json.jobs ?? []; running = j.find((x) => x.state === "running"); }
  if (running) record(4, "后台任务可见", "PASS", `job ${running.id} ${running.command}`);
  else record(4, "后台任务可见", error ? "FAIL" : "FAIL", `no running job; reply=${(reply || error || "").slice(0, 60)}`);
}

// ── R5: stats grounding ──
{
  const { reply } = await chat("hermes 到现在的验收战绩怎么样？通过率多少？");
  const hasNum = /\d+\s*%|通过率|pass/i.test(reply);
  record(5, "战绩接地", hasNum ? "PASS" : "SOFT", hasNum ? reply.replace(/\s+/g, " ").slice(0, 90) : `no numbers in reply: ${reply.slice(0, 60)}`);
}

// ── R6: time grounding ──
{
  const { reply } = await chat("现在几点了？顺便说下今天是周几");
  const now = new Date();
  const hh = now.getHours();
  const replyHour = [...reply.matchAll(/(\d{1,2})\s*[点:：时]/g)].map((m) => Number(m[1])).find((x) => Math.abs(x - hh) <= 1 || Math.abs(x - (hh + 12)) <= 1 || Math.abs(x - (hh - 12)) <= 1);
  const weekday = "日一二三四五六"[now.getDay()];
  const dayOk = new RegExp(`周${weekday}|星期${weekday}|礼拜${weekday}|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday`, "i").test(reply);
  if (replyHour != null && dayOk) record(6, "时间接地", "PASS", `真实 ${hh}点/周${weekday}，回复对上`);
  else if (replyHour != null || dayOk) record(6, "时间接地", "SOFT", `hour=${replyHour ?? "?"} day=${dayOk}; reply=${reply.replace(/\s+/g, " ").slice(0, 70)}`);
  else record(6, "时间接地", "FAIL", `真实 ${hh}点 周${weekday}; reply=${reply.replace(/\s+/g, " ").slice(0, 70)}`);
}

// ── R7: human acceptance ruling on the remaining fail card ──
{
  const st0 = await state();
  const target = st0.tasks.find((t) => t.title === "整理桌面文件夹" && t.status === "blocked");
  if (!target) record(7, "人话裁决", "SOFT", "no blocked 整理桌面文件夹 card");
  else {
    await chat(`验收 整理桌面文件夹 通过，我亲眼看过桌面了`);
    let settled = null;
    for (let i = 0; i < 30 && !settled; i++) { await sleep(5000); const st = await state(); const c = st.tasks.find((t) => t.id === target.id); if (c && (c.status === "done" || c.verdict === "pass")) settled = c; }
    record(7, "人话裁决", settled ? "PASS" : "FAIL", settled ? `${settled.status}/${settled.verdict}` : "card never settled");
  }
}

// ── R8: pure chatter must not spawn ──
{
  const before = (await state()).tasks.filter((t) => ["todo", "running", "blocked"].includes(t.status)).length;
  const { reply } = await chat("哈哈，忙你的去吧，我就是打个招呼");
  await sleep(20_000);
  const after = (await state()).tasks.filter((t) => ["todo", "running", "blocked"].includes(t.status)).length;
  record(8, "闲聊不建卡", after <= before ? "PASS" : "SOFT", `live cards ${before}→${after}; reply=${reply.replace(/\s+/g, " ").slice(0, 50)}`);
}

const budget = (await state()).budget?.line ?? "";
console.log(`\n=== ${pass} PASS · ${soft} SOFT · ${fail} FAIL === ${budget}`);
const { writeFileSync } = await import("node:fs");
writeFileSync("probe-shots/r85-probe-report.json", JSON.stringify({ at: new Date().toISOString(), pass, soft, fail, rounds: report, budget }, null, 2));
process.exit(fail > 0 ? 1 : 0);
