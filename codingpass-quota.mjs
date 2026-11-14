const provider = "codingpass-quota";
const usageURL = "https://codingpass.ai/api/app/usage";
const weekMs = 7 * 24 * 60 * 60 * 1000;
const cookieOctets = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

const windowFields = [
  { name: "5 小时", layer: "global_5h", used: "used5hMicro", limit: "limit5hMicro" },
  { name: "每周", layer: "global_week", used: "usedWeekMicro", limit: "limitWeekMicro" },
  { name: "每月", layer: "global_month", used: "usedMicro", limit: "limitMicro" },
];

function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function toUsage(data, now) {
  const { quota, live, subscription } = data ?? {};
  const rows = Array.isArray(live?.global) ? live.global : [];
  const monthStart = timestamp(quota?.monthStart);
  const monthEnd = timestamp(quota?.monthEnd);
  const windows = [];

  for (const fields of windowFields) {
    const used = quota?.[fields.used];
    const limit = quota?.[fields.limit];
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) continue;

    const window = {
      name: fields.name,
      used: (used / limit) * 100,
      amount: used / 1_000_000,
      limit: limit / 1_000_000,
      unit: "USD",
      aside: true,
    };

    let reset = timestamp(rows.find((row) => row?.layer === fields.layer)?.resetAt);
    let start;
    if (fields.layer === "global_5h") {
      // A new 5-hour window begins with the next request after the old one ends.
      if (live?.window5hStartAt === null) reset = NaN;
      if (reset > now) start = reset - 5 * 60 * 60 * 1000;
    } else if (fields.layer === "global_week") {
      if (reset > monthStart && reset <= monthEnd) {
        // The billing month's last week can end before a full seven days.
        const weekIndex = Math.floor((reset - monthStart - 1) / weekMs);
        start = monthStart + weekIndex * weekMs;
      }
    } else {
      if (!Number.isFinite(reset)) reset = monthEnd;
      start = monthStart;
    }

    if (reset > now) {
      window.resetsAt = new Date(reset).toISOString();
      if (start <= now && reset > start) window.span = (reset - start) / 1000;
    }
    windows.push(window);
  }

  return windows.length ? { plan: subscription?.planName, windows } : {
    error: "CodingPass 未返回可用的订阅额度。",
  };
}

async function readUsage(cookie, signal) {
  try {
    const response = await fetch(usageURL, {
      method: "POST",
      headers: { Cookie: `cp_session=${cookie}` },
      redirect: "error",
      signal,
    });
    if (response.status === 401) {
      return { error: "CodingPass 登录已失效，请更新 cp_session。", signIn: "expired" };
    }
    if (!response.ok) return { error: `CodingPass 额度查询返回 HTTP ${response.status}。` };

    const payload = await response.json();
    return toUsage(payload?.json, Date.now());
  } catch {
    return { error: "CodingPass 额度读取失败，请检查网络或稍后刷新。" };
  }
}

export default async function codingPassQuota() {
  return {
    config(config) {
      config.provider ??= {};
      config.provider[provider] = { name: "CodingPass Usage", models: {} };
    },
    auth: {
      provider,
      single: true,
      methods: [{
        type: "api",
        label: "CodingPass 登录 Cookie",
        prompts: [{ type: "password", key: "cookie", message: "cp_session 的值" }],
        async authorize(inputs, { signal } = {}) {
          const cookie = (inputs.cookie ?? "").trim().replace(/^cp_session=/, "");
          if (!cookieOctets.test(cookie)) {
            return { type: "failed", error: "请填写 cp_session 的值，勿粘贴整条 Cookie 请求头。" };
          }
          const usage = await readUsage(cookie, signal);
          if (usage.error) return { type: "failed", error: usage.error };
          // A renewed Cookie must keep the same history key for this personal account.
          return { type: "success", key: cookie, metadata: { email: "CodingPass" } };
        },
      }],
      async usage(getAuth, _provider, { signal } = {}) {
        const { key } = await getAuth();
        return readUsage(key, signal);
      },
    },
  };
}
