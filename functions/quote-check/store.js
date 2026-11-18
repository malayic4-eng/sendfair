/* Private storage for Quote Check orders, uploads and report PDFs.
   Uploads go to R2 when the QUOTE_CHECK_FILES binding exists, otherwise to the existing
   KV namespace for small files. Neither is ever served as a public URL. */

import { toBase64, fromBase64 } from "./bytes.js";

const ORDER_PREFIX = "qc:order:";
const TTL = 60 * 60 * 24 * 400;
const MAX_KV_FILE = 18 * 1024 * 1024;

export function orderKey(id) {
  return ORDER_PREFIX + id;
}

export function token(len = 26) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function newOrderId() {
  return token(10);
}

export async function putOrder(env, order) {
  const kv = env.SENDFAIR_KV;
  if (!kv) throw new Error("Quote Check storage is not configured.");
  order.updatedAt = new Date().toISOString();
  await kv.put(orderKey(order.id), JSON.stringify(order), { expirationTtl: TTL });
  if (order.token) await kv.put(`qc:token:${order.token}`, order.id, { expirationTtl: TTL });
  return order;
}

export async function getOrderByToken(env, viewToken) {
  const kv = env.SENDFAIR_KV;
  const t = String(viewToken || "");
  if (!kv || !/^[a-z0-9]{20,40}$/.test(t)) return null;
  const id = await kv.get(`qc:token:${t}`);
  return id ? getOrder(env, id) : null;
}

export async function getOrder(env, id) {
  const kv = env.SENDFAIR_KV;
  if (!kv || !/^[a-z0-9]{6,24}$/.test(String(id || ""))) return null;
  const raw = await kv.get(orderKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function listOrders(env, limit = 200) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return [];
  const result = await kv.list({ prefix: ORDER_PREFIX, limit: Math.max(1, Math.min(1000, limit)) });
  const orders = [];
  for (const key of result.keys || []) {
    const id = key.name.slice(ORDER_PREFIX.length);
    const order = await getOrder(env, id);
    if (order) orders.push(order);
  }
  orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return orders;
}

function uploadKey(orderId, fileId) {
  return `quote-check/${orderId}/upload/${fileId}`;
}

function pdfKey(orderId) {
  return `quote-check/${orderId}/report.pdf`;
}

export async function storeUpload(env, orderId, fileId, bytes, meta = {}) {
  if (env.QUOTE_CHECK_FILES && typeof env.QUOTE_CHECK_FILES.put === "function") {
    const key = uploadKey(orderId, fileId);
    await env.QUOTE_CHECK_FILES.put(key, bytes, { httpMetadata: { contentType: meta.type || "application/octet-stream" } });
    return { storage: "r2", key, size: bytes.byteLength };
  }
  const kv = env.SENDFAIR_KV;
  if (!kv) throw new Error("Quote Check storage is not configured.");
  if (bytes.byteLength > MAX_KV_FILE) {
    const err = new Error("The file is too large for the backup storage. Connect the R2 bucket QUOTE_CHECK_FILES and try again.");
    err.code = "storage_too_large";
    throw err;
  }
  const key = `qc:file:${orderId}:${fileId}`;
  await kv.put(key, toBase64(bytes), { expirationTtl: TTL });
  return { storage: "kv", key, size: bytes.byteLength };
}

export async function readUpload(env, order, file) {
  if (!file || !file.key) return null;
  if (file.storage === "r2") {
    if (!env.QUOTE_CHECK_FILES) return null;
    const obj = await env.QUOTE_CHECK_FILES.get(file.key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  const kv = env.SENDFAIR_KV;
  if (!kv) return null;
  const raw = await kv.get(file.key);
  return raw ? fromBase64(raw) : null;
}

export async function deleteUpload(env, file) {
  if (!file || !file.key) return;
  if (file.storage === "r2") {
    if (env.QUOTE_CHECK_FILES) await env.QUOTE_CHECK_FILES.delete(file.key).catch(() => {});
    return;
  }
  if (env.SENDFAIR_KV) await env.SENDFAIR_KV.delete(file.key).catch(() => {});
}

export async function storePdf(env, orderId, bytes) {
  if (env.QUOTE_CHECK_FILES && typeof env.QUOTE_CHECK_FILES.put === "function") {
    const key = pdfKey(orderId);
    await env.QUOTE_CHECK_FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    return { storage: "r2", key, size: bytes.byteLength };
  }
  const kv = env.SENDFAIR_KV;
  if (!kv) throw new Error("Quote Check storage is not configured.");
  const key = `qc:pdf:${orderId}`;
  await kv.put(key, toBase64(bytes), { expirationTtl: TTL });
  return { storage: "kv", key, size: bytes.byteLength };
}

export async function readPdf(env, order) {
  const file = order && order.report && order.report.pdf;
  if (!file || !file.key) return null;
  if (file.storage === "r2") {
    if (!env.QUOTE_CHECK_FILES) return null;
    const obj = await env.QUOTE_CHECK_FILES.get(file.key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  if (!env.SENDFAIR_KV) return null;
  const raw = await env.SENDFAIR_KV.get(file.key);
  return raw ? fromBase64(raw) : null;
}

export async function deletePdf(env, order) {
  const file = order && order.report && order.report.pdf;
  if (!file || !file.key) return;
  if (file.storage === "r2") {
    if (env.QUOTE_CHECK_FILES) await env.QUOTE_CHECK_FILES.delete(file.key).catch(() => {});
    return;
  }
  if (env.SENDFAIR_KV) await env.SENDFAIR_KV.delete(file.key).catch(() => {});
}
