/* Upload screening. Only PDF, JPG/PNG photos of a quote, XLSX and CSV are accepted.
   The extension, the magic bytes and the decoded content must agree; anything else is
   rejected before a byte reaches private storage. */

import { sha256Hex, toBase64 } from "./bytes.js";
import { xlsxToText } from "./xlsx.mjs";

const MB = 1024 * 1024;

function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function textLooksSafe(text) {
  const sample = text.slice(0, 4096);
  if (!sample.trim()) return false;
  if (sample.includes("\u0000")) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) bad++;
  }
  return bad / Math.max(1, sample.length) < 0.02;
}

export function sniff(bytes, name = "") {
  const lower = String(name || "").toLowerCase();
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: "pdf", mime: "application/pdf", ext: ".pdf" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "jpeg", mime: "image/jpeg", ext: lower.endsWith(".jpeg") ? ".jpeg" : ".jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "png", mime: "image/png", ext: ".png" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" };
  if (lower.endsWith(".csv")) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 8192));
    if (textLooksSafe(text)) return { kind: "csv", mime: "text/csv", ext: ".csv" };
  }
  return null;
}

function extensionMatches(name, ext) {
  const lower = String(name || "").toLowerCase();
  if (ext === ".jpg") return /\.(jpe?g)$/.test(lower);
  return lower.endsWith(ext);
}

export function safeName(name) {
  return String(name || "upload")
    .replace(/^.*[\\/]/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "upload";
}

export async function validateUploads(files, settings) {
  const list = Array.from(files || []).filter((f) => f && typeof f.arrayBuffer === "function");
  const limits = settings.limits;
  const maxFile = limits.maxFileMb * MB;
  const maxTotal = limits.maxTotalMb * MB;
  if (!list.length) return { ok: false, errors: ["Attach at least one file: a PDF, a photo of the quote, an XLSX or a CSV."] };
  if (list.length > limits.maxFiles) return { ok: false, errors: [`Attach no more than ${limits.maxFiles} files.`] };

  const errors = [];
  const out = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const name = safeName(file.name);
    if (file.size === 0) { errors.push(`${name}: the file is empty.`); continue; }
    if (file.size > maxFile) { errors.push(`${name}: the file is larger than ${limits.maxFileMb} MB.`); continue; }
    total += file.size;
    if (total > maxTotal) { errors.push(`The files together are larger than ${limits.maxTotalMb} MB.`); break; }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { errors.push(`${name}: the file could not be read.`); continue; }
    const kind = sniff(bytes, name);
    if (!kind) { errors.push(`${name}: that file type is not accepted. Use PDF, JPG/PNG, XLSX or CSV.`); continue; }
    if (!extensionMatches(name, kind.ext)) { errors.push(`${name}: the file contents are ${kind.kind.toUpperCase()} but the name does not match. Rename it or export it again.`); continue; }
    out.push({
      id: `f${i + 1}`,
      name,
      type: kind.mime,
      kind: kind.kind,
      ext: kind.ext,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      bytes
    });
  }
  if (!out.length && !errors.length) errors.push("No usable files were attached.");
  return { ok: errors.length === 0, errors, files: out, total };
}

/* Turn a stored upload into something the extraction provider can read. */
export async function fileForExtraction(file) {
  if (file.kind === "csv") {
    const text = new TextDecoder("utf-8").decode(file.bytes).replace(/^\uFEFF/, "");
    if (text.length > 200000) throw new Error("The CSV is too long. Split it into smaller files.");
    return { kind: "text", text, mime: "text/csv", name: file.name };
  }
  if (file.kind === "xlsx") {
    const text = await xlsxToText(file.bytes);
    if (text.length > 200000) throw new Error("The spreadsheet has too many rows. Split it into smaller files.");
    return { kind: "text", text, mime: file.type, name: file.name };
  }
  return { kind: "file", base64: toBase64(file.bytes), mime: file.type, name: file.name };
}
