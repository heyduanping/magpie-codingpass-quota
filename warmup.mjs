import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const provider = "codingpass-quota";
const hour = 3600_000;
const windowMs = 5 * hour;
const accountPattern = /^CodingPass [0-9a-f]{16}$/;
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const defaultModel = "deepseek-v4.1-flash";

export const warmupOptions = [
  // Magpie 0.1.4479 gives top-placed options its 46px title-bar height.
  { key: "warm_on_reset", label: "5 小时窗口重置后预热",
    description: "窗口空闲时向指定账号发一条短消息，使用该账号的额度。多个账号请在插件选项中指定 warmupAccount。" },
  { key: "warm_daily", label: "每日定时预热",
    description: "按本机时间预热空闲窗口。默认 09:00，可在插件选项 warmupTimes 中设置多个时间。" },
];

function gateway() {
  const addr = process.env.MAGPIE_ADDR || "127.0.0.1:3425";
  const url = new URL(addr.includes("://") ? addr : "http://" + addr);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("请用 MAGPIE_ADDR 指定本机 Magpie 网关。");
  }
  return url.origin;
}

async function request(path, init = {}) {
  const res = await fetch(gateway() + path, {
    ...init, signal: AbortSignal.timeout(35_000), redirect: "error",
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Magpie ${path.split("?")[0]} 返回 HTTP ${res.status}。`);
  }
  return res.json();
}

async function accounts() {
  const { data } = await request("/v1/magpie/quotas?kept=1");
  return [...new Set(data.filter(c => c.provider === provider && accountPattern.test(c.user)).map(c => c.user))];
}

function refresh(account) {
  const query = new URLSearchParams({ provider, user: account });
  return request("/v1/magpie/quotas/refresh?" + query, { method: "POST" });
}

function checkTarget(account, model) {
  if (typeof account !== "string" || !accountPattern.test(account)) throw new Error("请选择完整登录的 CodingPass 账号。");
  if (typeof model !== "string" || !modelPattern.test(model)) throw new Error("请填写 CodingPass 模型 ID。");
}

export async function sendWarmup(account, model) {
  checkTarget(account, model);
  const reply = await request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-account": account, "x-magpie-wait": "30" },
    body: JSON.stringify({
      model: provider + "/" + model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false,
    }),
  });
  if (!reply?.choices?.[0]?.message || !reply.choices[0].finish_reason) {
    throw new Error("模型回复不完整，预热结果未知。");
  }
}

// Like Claude's warmer, allow an hour after a daily start. Reserve the next
// chosen start if opening a five-hour window now would run past it.
export function dueNow(now, onReset, times) {
  let previous = -Infinity;
  let next = Infinity;
  for (const time of times) {
    if (typeof time !== "string" || !clockPattern.test(time)) throw new Error("warmupTimes 需要 HH:MM 格式的本机时间。");
    const [h, m] = time.split(":").map(Number);
    for (const offset of [-1, 0, 1]) {
      const slot = new Date(now);
      slot.setDate(slot.getDate() + offset);
      slot.setHours(h, m, 0, 0);
      if (+slot <= now) previous = Math.max(previous, +slot);
      else next = Math.min(next, +slot);
    }
  }
  return now - previous <= hour || (onReset && next - now >= windowMs);
}

// Reserve before sending. A timeout or host restart can lose a reply after
// CodingPass has opened the window. Overlapping Magpie hosts share this row.
async function openReservations(directory) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(directory, "codingpass-warmup.sqlite"), { create: true });
  db.exec("PRAGMA busy_timeout=2000");
  db.exec("CREATE TABLE IF NOT EXISTS attempts (account TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)");
  const find = db.query("SELECT until_ms FROM attempts WHERE account = ?");
  const claim = db.query(`INSERT INTO attempts VALUES (?, ?)
    ON CONFLICT(account) DO UPDATE SET until_ms = excluded.until_ms WHERE attempts.until_ms <= ?`);
  return {
    close: () => db.close(),
    held: (account, now) => (find.get(account)?.until_ms ?? 0) > now,
    claim: (account, now) => claim.run(account, now + windowMs, now).changes === 1,
  };
}

export function startWarmup(input, options = {}) {
  if (!input?.magpie?.option || !input.directory) return;
  const isOn = key => input.magpie.option(provider, key);
  const due = () => {
    const daily = isOn("warm_daily");
    if (!daily && !isOn("warm_on_reset")) return false;
    const times = daily ? options.warmupTimes ?? ["09:00"] : [];
    if (!Array.isArray(times)) throw new Error("warmupTimes 需要时间数组。");
    return dueNow(Date.now(), isOn("warm_on_reset"), times);
  };
  const observations = new Map();
  let busy = false;
  let retryAfter = 0;
  let lastError = "";

  async function tick() {
    if (busy || Date.now() < retryAfter) return;
    busy = true;
    let reservations;
    try {
      if (!due()) return;
      let account = options.warmupAccount;
      if (!account) {
        const users = await accounts();
        if (users.length !== 1) throw new Error("请刷新 CodingPass 额度，并在插件选项 warmupAccount 指定一个可用账号。");
        [account] = users;
      }
      const model = options.warmupModel ?? defaultModel;
      checkTarget(account, model);
      reservations = await openReservations(input.directory);
      if (reservations.held(account, Date.now())) return;

      // An ordinary usage read may already have seen this window running.
      // Only a fresh, identity-checked vendor reading permits a send.
      const previous = observations.get(account);
      if (previous?.resetsAt > Date.now()) return;
      await refresh(account);
      const sample = observations.get(account);
      if (sample === previous || !sample?.canWarm || Date.now() - sample.at > 30_000 || !due()) return;
      if (!reservations.claim(account, Date.now())) return;
      await sendWarmup(account, model);
      console.info(`CodingPass 已向 ${account} 的 ${model} 发送预热。`);
      lastError = "";
      // Magpie rate-limits refreshes of the same card for 30 seconds.
      setTimeout(() => refresh(account).catch(error => console.warn("额度刷新失败：" + error.message)), 31_000).unref?.();
    } catch (error) {
      if (lastError !== error.message) console.warn("CodingPass 预热：" + error.message);
      lastError = error.message;
      retryAfter = Date.now() + 5 * 60_000;
    } finally {
      reservations?.close();
      busy = false;
    }
  }

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return {
    observe(account, canWarm, usage) {
      if (!accountPattern.test(account)) return;
      const blocking = usage.windows?.filter(w => w.name === "5 小时" || w.used >= 100) ?? [];
      const resetsAt = Math.max(0, ...blocking.map(w => Date.parse(w.resetsAt) || 0));
      observations.set(account, { canWarm, resetsAt, at: Date.now() });
    },
  };
}

async function main([action, account, model]) {
  if (action === "list") {
    for (const name of await accounts()) console.log(name);
    return;
  }
  if (action !== "now" || !account || !model) {
    throw new Error('用法：node warmup.mjs list，或 node warmup.mjs now "CodingPass 账号标识" 模型ID');
  }
  await sendWarmup(account, model);
  console.log(`已向 ${account} 的 ${model} 发送预热。`);
  try { await refresh(account); }
  catch (error) { console.warn("额度刷新失败：" + error.message); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
