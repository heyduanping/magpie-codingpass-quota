import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import provider from "../codingpass-provider.mjs";
import { dueNow, sendWarmup } from "../warmup.mjs";

const originalFetch = globalThis.fetch;
const originalInterval = globalThis.setInterval;
const originalTimeout = globalThis.setTimeout;
const originalAddr = process.env.MAGPIE_ADDR;
const scratch = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalInterval;
  globalThis.setTimeout = originalTimeout;
  if (originalAddr === undefined) delete process.env.MAGPIE_ADDR;
  else process.env.MAGPIE_ADDR = originalAddr;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("定时跨午夜可补发一小时，重置预热为下一次定时留出五小时", () => {
  const at = (day, h, m) => +new Date(2026, 10, day, h, m);
  expect(dueNow(at(20, 0, 20), false, ["09:00", "23:30"])).toBe(true);
  expect(dueNow(at(20, 0, 31), false, ["23:30"])).toBe(false);
  expect(dueNow(at(20, 4, 1), true, ["09:00"])).toBe(false);
  expect(dueNow(at(20, 4, 0), true, ["09:00"])).toBe(true);
  expect(dueNow(at(20, 17, 0), true, [])).toBe(true);
  expect(dueNow(at(20, 17, 0), false, [])).toBe(false);
  expect(() => dueNow(Date.now(), false, ["25:00"])).toThrow();
});

const id = "codingpass-quota";
const account = "CodingPass " + createHash("sha256").update("42").digest("hex").slice(0, 16);
const model = "deepseek-v4.1-flash";
const auth = { type: "api", key: "cp-live-fixture", metadata: { email: account, usageCookie: "fixture" } };

test("多个额度账号且未指定目标时，不挑选账号或发送模型请求", async () => {
  let tick;
  globalThis.setInterval = fn => { tick = fn; return { unref() {} }; };
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    expect(new URL(url).pathname).toBe("/v1/magpie/quotas");
    return Response.json({ data: [account, "CodingPass ffffffffffffffff"].map(user => ({ user, provider: id })) });
  };
  process.env.MAGPIE_ADDR = "127.0.0.1:49002";
  await provider({ directory: tmpdir(), magpie: { option: (_, k) => k === "warm_on_reset" } });
  await tick();
  expect(calls).toBe(1);
});

test("手动请求固定账号、模型和输出上限，拒绝旧账号与不完整回复", async () => {
  process.env.MAGPIE_ADDR = "localhost:49001";
  let calls = 0;
  globalThis.fetch = async (url, req) => {
    ++calls;
    expect(url).toBe("http://localhost:49001/v1/chat/completions");
    expect(req.headers["x-magpie-account"]).toBe(account);
    expect(JSON.parse(req.body)).toEqual({ model: id + "/" + model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false });
    return Response.json({ choices: [] });
  };
  await expect(sendWarmup("CodingPass", model)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(sendWarmup(account, model)).rejects.toThrow("回复不完整");
  expect(calls).toBe(1);
  globalThis.fetch = async () => new Response(null, { status: 429 });
  await expect(sendWarmup(account, model)).rejects.toThrow("429");
});

test("自动预热经额度查询及模型转发执行，重启后保留发送记录", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codingpass-warmup-"));
  scratch.push(directory);
  const ticks = [];
  globalThis.setInterval = fn => { ticks.push(fn); return { unref() {} }; };
  let refreshLater;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 31_000) return originalTimeout(fn, ms, ...args);
    refreshLater = fn;
    return { unref() {} };
  };
  process.env.MAGPIE_ADDR = "127.0.0.1:49002";
  let enabled = false;
  const input = { directory, magpie: { option: (_, key) => enabled && key === "warm_on_reset" } };
  let plugin = await provider(input, { warmupAccount: account });
  let start = null;
  let subscription = 42;
  let week = 0;
  let broken = false;
  let network = 0;
  let sends = 0;
  globalThis.fetch = async (url, req = {}) => {
    network++;
    const path = new URL(url).pathname;
    if (path === "/v1/magpie/quotas") return Response.json({ data: [{ provider: id, user: account }] });
    if (path === "/v1/magpie/quotas/refresh") {
      expect(new URL(url).searchParams.get("user")).toBe(account);
      await plugin.auth.usage(async () => auth);
      return Response.json({});
    }
    if (path === "/api/app/usage") {
      expect(req.headers.Cookie).toBe("cp_session=fixture");
      if (broken) return new Response(null, { status: 401 });
      return Response.json({ json: {
        subscription: { id: subscription }, live: { window5hStartAt: start },
        quota: { used5hMicro: 0, limit5hMicro: 10, usedWeekMicro: week, limitWeekMicro: 20, usedMicro: 1, limitMicro: 50 },
      } });
    }
    if (path === "/v1/chat/completions" && new URL(url).hostname === "127.0.0.1") {
      expect(req.headers["x-magpie-account"]).toBe(account);
      const transport = await plugin.auth.loader(async () => auth);
      return transport.fetch("https://codingpass.ai/v1/chat/completions", req);
    }
    if (path === "/v1/chat/completions" && new URL(url).origin === "https://codingpass.ai") {
      expect(req.headers.get("authorization")).toBe("Bearer cp-live-fixture");
      expect(req.headers.has("cookie")).toBe(false);
      sends++;
      return Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] });
    }
    throw new Error("Unexpected request");
  };
  await ticks[0]();
  expect(network).toBe(0);
  enabled = true;
  start = new Date().toISOString();
  await ticks[0]();
  start = undefined;
  await ticks[0]();
  start = null;
  week = 20;
  await ticks[0]();
  week = 0;
  subscription = 99;
  await ticks[0]();
  subscription = 42;
  broken = true;
  await ticks[0]();
  expect(sends).toBe(0);
  broken = false;
  await Promise.all([ticks[0](), ticks[0]()]);
  expect(sends).toBe(1);
  await refreshLater();
  plugin = await provider(input, { warmupAccount: account });
  await ticks[1]();
  expect(sends).toBe(1);
});
