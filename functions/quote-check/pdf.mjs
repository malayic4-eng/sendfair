/* A tiny PDF writer. No dependency, ASCII-only, built for printable reports.
   Coordinates are given from the top-left, which makes page layout readable. */

function latin1(text) {
  const s = String(text == null ? "" : text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function ascii(text) {
  return String(text == null ? "" : text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\u00b7/g, "-")
    .replace(/\u00b2/g, "2")
    .replace(/\u00b3/g, "3")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7e\n]/g, "?");
}

function pdfEscape(text) {
  return ascii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r?\n/g, " ");
}

const WIDTHS = {
  " ": 0.28, i: 0.28, l: 0.28, j: 0.28, t: 0.32, f: 0.32, r: 0.36, ".": 0.28, ",": 0.28,
  ":": 0.28, ";": 0.28, "'": 0.24, '"': 0.4, "!": 0.28, "|": 0.26, "/": 0.28, "-": 0.34,
  m: 0.86, w: 0.76, M: 0.88, W: 0.94, "&": 0.68, "@": 0.92, "%": 0.84
};

export class PdfDoc {
  constructor(options = {}) {
    this.width = options.width || 595;
    this.height = options.height || 842;
    this.margin = options.margin == null ? 40 : options.margin;
    this.pages = [];
    this.page = null;
    this.newPage();
  }

  newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    return this;
  }

  get pageNo() {
    return this.pages.length;
  }

  widthOf(text, size = 10, bold = false) {
    let units = 0;
    for (const ch of ascii(text)) {
      if (WIDTHS[ch] != null) units += WIDTHS[ch];
      else if (ch >= "A" && ch <= "Z") units += 0.68;
      else if (ch >= "0" && ch <= "9") units += 0.56;
      else units += 0.51;
    }
    return units * size * (bold ? 1.04 : 1);
  }

  wrap(text, maxWidth, size = 10, bold = false) {
    const source = ascii(text).replace(/\s+/g, " ").trim();
    if (!source) return [""];
    const words = source.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.widthOf(candidate, size, bold) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      while (this.widthOf(line, size, bold) > maxWidth && line.length > 1) {
        let cut = line.length;
        while (cut > 1 && this.widthOf(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut).trim();
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  text(x, top, text, opts = {}) {
    const size = opts.size || 10;
    const bold = !!opts.bold;
    const color = opts.color || [0.08, 0.09, 0.2];
    const y = this.height - top - size;
    this.page.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color[0]} ${color[1]} ${color[2]} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfEscape(text)}) Tj ET`);
    return size * 1.35;
  }

  line(x1, top1, x2, top2, opts = {}) {
    const color = opts.color || [0.82, 0.84, 0.9];
    const w = opts.width || 0.6;
    this.page.ops.push(`${color[0]} ${color[1]} ${color[2]} RG ${w} w ${x1.toFixed(2)} ${(this.height - top1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - top2).toFixed(2)} l S`);
  }

  rect(x, top, w, h, opts = {}) {
    const fill = opts.fill;
    const stroke = opts.stroke;
    const parts = [];
    if (fill) parts.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) parts.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG ${opts.width || 0.6} w`);
    const y = this.height - top - h;
    parts.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    parts.push(fill && stroke ? "B" : fill ? "f" : "S");
    this.page.ops.push(parts.join(" "));
  }

  output() {
    const objects = [];
    const pageObjects = [];
    const font1 = objects.length + 3;
    const font2 = objects.length + 4;
    // 1 catalog, 2 pages, 3-4 fonts, then page/content pairs.
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    for (const page of this.pages) {
      const content = page.ops.join("\n");
      const pageObjNum = objects.length + 1;
      const contentObjNum = pageObjNum + 1;
      pageObjects.push(pageObjNum);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentObjNum} 0 R >>`);
      objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`;

    let pdf = "%PDF-1.4\n%----\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets[i + 1] = pdf.length;
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return latin1(pdf);
  }
}
