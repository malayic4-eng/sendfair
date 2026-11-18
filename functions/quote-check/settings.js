/* Quote Check settings and data loader for the Worker.
   The static build writes /data/quote-check/config.json and synonyms.json, so the Worker
   reads the same files the owner edits. Env vars override the switches at runtime. */

import { mergeConfig, isEnabled, isTestMode, priceFor } from "../../src/quote-check/config.mjs";

let cache = null;

async function assetJson(env, request, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!res.ok) throw new Error(`Missing ${path}`);
  return res.json();
}

export async function loadSettings(env, request) {
  if (cache && cache.origin === new URL(request.url).origin) return cache;
  const [rawConfig, synonyms] = await Promise.all([
    assetJson(env, request, "/data/quote-check/config.json").catch(() => ({})),
    assetJson(env, request, "/data/quote-check/synonyms.json").catch(() => ({ global: {}, countries: {}, exclude: [] }))
  ]);
  const config = mergeConfig(rawConfig);
  cache = { origin: new URL(request.url).origin, config, synonyms };
  return cache;
}

export function enabled(env, config) {
  return isEnabled(env, config);
}

export function testMode(env, config) {
  return isTestMode(env, config);
}

export function price(env, config, quoteCurrency) {
  return priceFor(config, quoteCurrency);
}

export function paymentProviderId(env, config) {
  if (isTestMode(env, config)) return "test";
  if (env.PAYMENT_PROVIDER) return String(env.PAYMENT_PROVIDER).toLowerCase();
  return String((config.payment && config.payment.provider) || "test").toLowerCase();
}
