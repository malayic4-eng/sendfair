/* Minimal XLSX reader for bill-of-quantities files. It reads the first worksheet and turns
   it into tab-separated text, which the extraction model handles like a CSV. No third-party
   dependency, and no macro or formula execution. */

const MAX_ENTRY = 10 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

function findEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("This runtime cannot open XLSX files.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(bytes) {
  if (bytes.length < 22) throw new Error("The XLSX file is too small.");
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error("The XLSX file is not a readable ZIP archive.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = u16(view, eocd + 10);
  const dirOffset = u32(view, eocd + 16);
  if (dirOffset >= bytes.length) throw new Error("The XLSX archive is damaged.");
  const files = new Map();
  let cursor = dirOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > bytes.length || u32(view, cursor, true) !== 0x02014b50) break;
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLen = u16(view, cursor + 28);
    const extraLen = u16(view, cursor + 30);
    const commentLen = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;
    if (uncompressedSize > MAX_ENTRY) continue;
    if (localOffset + 30 > bytes.length) continue;
    if (u32(view, localOffset, true) !== 0x04034b50) continue;
    const localNameLen = u16(view, localOffset + 26);
    const localExtraLen = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) continue;
    const raw = bytes.subarray(dataStart, dataEnd);
    total += uncompressedSize;
    if (total > MAX_TOTAL) throw new Error("The XLSX file is too large to read safely.");
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = await inflateRaw(raw);
    else continue;
    files.set(name, content);
  }
  return files;
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(xml) {
  return decodeXml(String(xml || "").replace(/<[^>]*>/g, ""));
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function sharedStrings(xml) {
  const out = [];
  for (const match of String(xml || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
    out.push(texts.join(""));
  }
  return out;
}

function sheetText(xml, shared) {
  const rows = [];
  for (const rowMatch of String(xml || "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= 2000) break;
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const refMatch = attrs.match(/\br="([A-Z]+\d+)"/i);
      const col = refMatch ? columnIndex(refMatch[1]) : cells.length;
      if (col > 60) continue;
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : "";
      let value = "";
      if (type === "inlineStr") {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
      } else {
        const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (v) {
          if (type === "s") value = shared[Number(v[1])] || "";
          else if (type === "b") value = v[1] === "1" ? "TRUE" : "FALSE";
          else value = decodeXml(v[1]);
        } else {
          const inline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          if (inline) value = decodeXml(inline[1]);
        }
      }
      cells[col] = String(value).replace(/[\t\r\n]+/g, " ").trim();
    }
    if (cells.some((c) => c && c.trim())) {
      rows.push(Array.from(cells, (c) => c || "").join("\t").replace(/\t+$/, ""));
    }
  }
  return rows.join("\n");
}

export async function xlsxToText(bytes) {
  const files = await unzip(bytes);
  const shared = files.has("xl/sharedStrings.xml") ? sharedStrings(new TextDecoder().decode(files.get("xl/sharedStrings.xml"))) : [];
  let sheet = null;
  for (const name of files.keys()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) { sheet = name; break; }
  }
  if (!sheet) throw new Error("The XLSX file has no worksheet.");
  const text = sheetText(new TextDecoder().decode(files.get(sheet)), shared);
  if (!text.trim()) throw new Error("The first worksheet is empty.");
  return text;
}
