import { createHash } from "node:crypto";
import codingPassQuota, { quota } from "./codingpass-quota.mjs";
import { startWarmup, warmupOptions } from "./warmup.mjs";

const origin = "https://codingpass.ai";
const baseURL = `${origin}/v1`;
const anthropic = "@ai-sdk/anthropic";
const responses = "@ai-sdk/openai";
const chat = "@ai-sdk/openai-compatible";
const messagesPaths = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const openAIPaths = new Set(["/v1/chat/completions", "/v1/responses"]);
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const apiKeyFormat = /^cp-live-[A-Za-z0-9._~+\/=-]+$/;

function accountName(subscriptionId) {
  let value = typeof subscriptionId === "string" ? subscriptionId.trim() : "";
  if (Number.isSafeInteger(subscriptionId) && subscriptionId > 0) value = String(subscriptionId);
  if (!value) return "";
  const id = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `CodingPass ${id}`;
}

function hasModelKey(auth) {
  return auth?.type === "api" && apiKeyFormat.test(auth.key ?? "") &&
    Boolean(auth.metadata?.usageCookie);
}

async function listModels(key, signal) {
  let response;
  try {
    response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error("无法连接 CodingPass 模型接口。");
  }
  if (response.status === 401) {
    throw Object.assign(new Error("CodingPass API Key 无效或已吊销。"), { signIn: "expired" });
  }
  if (!response.ok) throw new Error(`CodingPass 模型列表返回 HTTP ${response.status}。`);

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.data)) throw new Error("CodingPass 返回的模型列表格式有误。");
  return payload.data.filter((model) => typeof model?.id === "string" && modelId.test(model.id));
}

async function authorize(inputs, { signal } = {}) {
  const key = typeof inputs?.apiKey === "string" ? inputs.apiKey.trim() : "";
  const cookie = quota.normalizeCookie(inputs?.cookie);
  if (!apiKeyFormat.test(key)) return { type: "failed", error: "请填写 CodingPass 的 cp-live-… API Key。" };
  if (!cookie) return { type: "failed", error: "请填写同一 CodingPass 账号的 cp_session。" };

  try {
    const [{ usage, subscriptionId }] = await Promise.all([
      quota.readQuota(cookie, signal),
      listModels(key, signal),
    ]);
    const name = accountName(subscriptionId);
    if (usage.error) return { type: "failed", error: usage.error };
    if (!name) return { type: "failed", error: "CodingPass 未返回订阅标识，无法区分账号。" };
    return { type: "success", key, metadata: { email: name, usageCookie: cookie } };
  } catch (error) {
    return { type: "failed", error: error.message };
  }
}

async function fetchModel(input, init, getAuth) {
  const auth = await getAuth();
  if (!hasModelKey(auth)) throw new Error("此 CodingPass 登录没有模型 API Key。");

  const url = new URL(input);
  const isMessages = messagesPaths.has(url.pathname);
  if (url.origin !== origin || url.username || url.password || init.method !== "POST" ||
      (!isMessages && !openAIPaths.has(url.pathname))) {
    throw new Error("不支持的 CodingPass 模型请求地址或方法。");
  }

  const headers = new Headers(init.headers);
  for (const name of ["cookie", "authorization", "x-api-key", "x-goog-api-key", "proxy-authorization"]) {
    headers.delete(name);
  }
  if (isMessages) {
    headers.set("x-api-key", auth.key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("Authorization", `Bearer ${auth.key}`);
  }
  return fetch(url, { ...init, headers, redirect: "error" });
}

function asModel(model, known) {
  const { id, display_name: displayName } = model;
  const family = id.toLowerCase();
  const npm = family.startsWith("claude-") ? anthropic : family.startsWith("gpt-") ? responses : chat;
  return {
    ...known,
    id,
    name: typeof displayName === "string" && displayName.trim() ? displayName : known?.name ?? id,
    api: { id, url: baseURL, npm },
    also: [chat, responses, anthropic].filter((protocol) => protocol !== npm),
  };
}

export default async function codingPassProvider(input, options) {
  const legacy = await codingPassQuota();
  const provider = legacy.auth.provider;
  const warmer = startWarmup(input, options);
  return {
    config(config) {
      legacy.config(config);
      Object.assign(config.provider[provider], { name: "CodingPass", api: baseURL, npm: chat });
    },
    auth: {
      provider,
      options: warmupOptions,
      methods: [{
        type: "api",
        label: "CodingPass API Key 和额度 Cookie",
        prompts: [
          { type: "password", key: "apiKey", message: "CodingPass API Key" },
          { type: "password", key: "cookie", message: "同一账号的 cp_session 值" },
        ],
        authorize,
      }],
      async loader(getAuth) {
        // Even a legacy Cookie-only account must never use its Cookie as an SDK key.
        return { baseURL, apiKey: "unused", fetch: (input, init) => fetchModel(input, init, getAuth) };
      },
      async usage(getAuth, context, options) {
        const auth = await getAuth();
        if (!auth?.metadata?.usageCookie) {
          if (auth?.metadata?.email === "CodingPass" && quota.normalizeCookie(auth.key)) {
            return legacy.auth.usage(getAuth, context, options);
          }
          return { error: "请登录 CodingPass 并填写额度 Cookie。", signIn: "kept" };
        }

        const { usage, subscriptionId, canWarm } = await quota.readQuota(auth.metadata.usageCookie, options?.signal);
        const sameAccount = accountName(subscriptionId) === auth.metadata.email;
        warmer?.observe(auth.metadata.email, sameAccount && hasModelKey(auth) && canWarm === true, usage);
        if (!usage.error && !sameAccount) {
          return { error: "CodingPass 额度查询返回了不同的订阅，请重新登录。", signIn: "kept" };
        }
        // This check only speaks for the web session. Model requests check the API Key.
        return { ...usage, signIn: "kept" };
      },
    },
    provider: {
      id: provider,
      async models(info, { auth, signal } = {}) {
        if (!hasModelKey(auth)) return {};
        const models = await listModels(auth.key, signal);
        return Object.fromEntries(models.map((model) => [model.id, asModel(model, info.models?.[model.id])]));
      },
    },
  };
}
