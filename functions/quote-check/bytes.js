/* Small byte helpers that work in Workers and Node. */

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(String(text == null ? "" : text));
}

export function fromUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

export function constantTimeEqual(a, b) {
  const x = String(a == null ? "" : a);
  const y = String(b == null ? "" : b);
  if (x.length !== y.length) return false;
  let same = 0;
  for (let i = 0; i < x.length; i++) same |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return same === 0;
}

export async function sha256Hex(bytesOrText) {
  const data = typeof bytesOrText === "string" ? utf8(bytesOrText) : bytesOrText;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
