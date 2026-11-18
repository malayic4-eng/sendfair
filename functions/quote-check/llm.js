/* LLM extraction provider. Swappable: openai, anthropic, google or mock.
   The key comes from the Worker environment; nothing is stored with the upload. */

import { EXTRACTION_SCHEMA } from "../../src/quote-check/validate.mjs";
import { fileForExtraction } from "./files.js";

const DEFAULTS = {
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash"
};

function providerFor(env, settings) {
  return String(env.LLM_PROVIDER || (settings.extraction && settings.extraction.provider) || "openai").toLowerCase();
}

function keyFor(env, provider) {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  if (provider === "openai") return env.OPENAI_API_KEY || "";
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY || "";
  if (provider === "google") return env.GOOGLE_API_KEY || "";
  return "";
}

function modelFor(env, settings, provider) {
  return env.LLM_MODEL || (settings.extraction && settings.extraction.model) || DEFAULTS[provider] || "";
}

function stripJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

function parseJson(text) {
  return JSON.parse(stripJson(text));
}

function responseText(provider, data) {
  if (!data) return "";
  if (provider === "openai") {
    if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
    const parts = [];
    for (const item of data.output || []) {
      for (const content of item.content || []) {
        if (content && typeof content.text === "string") parts.push(content.text);
        if (content && typeof content.text === "object" && content.text && typeof content.text.value === "string") parts.push(content.text.value);
      }
    }
    return parts.join("\n");
  }
  if (provider === "anthropic") {
    return (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  }
  if (provider === "google") {
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return (parts || []).map((p) => p.text || "").join("\n");
  }
  return "";
}

async function fetchJson(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`The extraction provider returned HTTP ${res.status}.`);
      err.code = "llm_http";
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    try { return JSON.parse(text); } catch {
      const err = new Error("The extraction provider returned a response that was not JSON.");
      err.code = "llm_response";
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function openaiExtract({ env, settings, parts, prompt }) {
  const key = keyFor(env, "openai");
  const base = String(env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const content = [{ type: "input_text", text: prompt }];
  for (const part of parts) {
    if (part.kind === "text") content.push({ type: "input_text", text: `FILE: ${part.name}\n---\n${part.text}\n---` });
    else if (part.mime === "application/pdf") content.push({ type: "input_file", filename: part.name, file_data: `data:application/pdf;base64,${part.base64}` });
    else content.push({ type: "input_image", image_url: `data:${part.mime};base64,${part.base64}` });
  }
  const data = await fetchJson(`${base}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: modelFor(env, settings, "openai"),
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "quote_extraction", strict: true, schema: EXTRACTION_SCHEMA } }
    })
  });
  return responseText("openai", data);
}

async function anthropicExtract({ env, settings, parts, prompt }) {
  const key = keyFor(env, "anthropic");
  const content = [{ type: "text", text: prompt }];
  for (const part of parts) {
    if (part.kind === "text") content.push({ type: "text", text: `FILE: ${part.name}\n---\n${part.text}\n---` });
    else if (part.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: part.base64 } });
    else content.push({ type: "image", source: { type: "base64", media_type: part.mime, data: part.base64 } });
  }
  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: modelFor(env, settings, "anthropic"),
      max_tokens: 8192,
      temperature: 0,
      system: "Return only the JSON object the user asks for. No commentary.",
      messages: [{ role: "user", content }]
    })
  });
  return responseText("anthropic", data);
}

async function googleExtract({ env, settings, parts, prompt }) {
  const key = keyFor(env, "google");
  const model = modelFor(env, settings, "google");
  const blocks = [{ text: prompt }];
  for (const part of parts) {
    if (part.kind === "text") blocks.push({ text: `FILE: ${part.name}\n---\n${part.text}\n---` });
    else blocks.push({ inline_data: { mime_type: part.mime, data: part.base64 } });
  }
  const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: blocks }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" }
    })
  });
  return responseText("google", data);
}

async function mockExtract({ env, request, meta }) {
  const countryId = String(meta.countryId || "");
  const url = new URL(`/data/quote-check/fixtures/${countryId}.json`, request.url);
  const res = await env.ASSETS.fetch(new Request(url));
  if (!res.ok) {
    const err = new Error(`Test mode has no sample quote for ${meta.countryName || countryId}. Try Kenya, Nigeria or Ghana.`);
    err.code = "fixture_missing";
    throw err;
  }
  const fixture = await res.json();
  return { raw: fixture.extraction, provider: "mock", model: "fixture" };
}

export async function extractQuote({ env, request, settings, files, meta, testMode }) {
  const provider = testMode ? "mock" : providerFor(env, settings);
  if (provider === "mock") return mockExtract({ env, request, meta });

  const key = keyFor(env, provider);
  if (!key) {
    const err = new Error("Quote Check extraction is not configured yet.");
    err.code = "llm_not_configured";
    throw err;
  }
  if (!["openai", "anthropic", "google"].includes(provider)) {
    const err = new Error(`Unknown extraction provider: ${provider}`);
    err.code = "llm_provider";
    throw err;
  }

  const parts = [];
  for (const file of files) parts.push(await fileForExtraction(file));
  if (!parts.length) {
    const err = new Error("No readable file was attached.");
    err.code = "no_files";
    throw err;
  }

  const { buildUserPrompt } = await import("./prompt.mjs");
  const prompt = buildUserPrompt(meta);
  const call = provider === "openai" ? openaiExtract : provider === "anthropic" ? anthropicExtract : googleExtract;

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await call({
        env,
        settings,
        parts,
        prompt: attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was not valid JSON. Return only the JSON object, with no markdown and no explanation.`
      });
      return { raw: parseJson(reply), provider, model: modelFor(env, settings, provider) };
    } catch (err) {
      lastError = err;
      if (err && (err.code === "llm_not_configured" || err.code === "no_files")) throw err;
      if (err && err.status && err.status < 500 && err.status !== 429) throw err;
    }
  }
  const err = new Error("The extraction provider could not read this quote. Try a clearer photo or a PDF, or email us.");
  err.code = "llm_failed";
  err.cause = lastError;
  throw err;
}
