/**
 * Minimal, dependency-free PDF 1.4 writer for AuditReport. Runs entirely on
 * the device: no fonts are fetched (it uses the standard Helvetica fonts every
 * PDF reader has) and no library is loaded.
 *
 * Text is encoded as WinAnsi. Characters outside WinAnsi are replaced with a
 * close ASCII equivalent (e.g. "≥" → ">="). The output is pure ASCII, so byte
 * offsets in the cross-reference table equal string offsets.
 */
import type { AuditReport, ReportBlock } from "./audit-report";

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_Y = 32;

// Helvetica advance widths (1/1000 em) for ASCII 32–126.
// prettier-ignore
const HELVETICA = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];

// Unicode → WinAnsi byte for the non-Latin-1 characters WinAnsi supports.
const WIN_ANSI: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "„": 0x84,
  "…": 0x85,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "™": 0x99,
};
const REPLACEMENTS: Record<string, string> = {
  "≥": ">=",
  "≤": "<=",
  "→": "->",
  "←": "<-",
  "−": "-",
  "›": ">",
  "‹": "<",
  "×": "x",
  "✓": "v",
  " ": " ",
};

function toWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const replacement = REPLACEMENTS[char];
    if (replacement !== undefined) {
      bytes.push(...[...replacement].map((c) => c.charCodeAt(0)));
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (WIN_ANSI[char] !== undefined) bytes.push(WIN_ANSI[char]);
    else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
    else bytes.push(0x3f); // "?"
  }
  return bytes;
}

/** A PDF literal string, ASCII-only: escapes ( ) \ and writes other bytes as octal. */
function pdfString(text: string): string {
  return `(${toWinAnsi(text)
    .map((byte) => {
      if (byte === 0x28 || byte === 0x29 || byte === 0x5c) return `\\${String.fromCharCode(byte)}`;
      if (byte < 32 || byte > 126) return `\\${byte.toString(8).padStart(3, "0")}`;
      return String.fromCharCode(byte);
    })
    .join("")})`;
}

function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const byte of toWinAnsi(text))
    units += byte >= 32 && byte <= 126 ? HELVETICA[byte - 32]! : 600;
  return (units / 1000) * size * (bold ? 1.08 : 1.02);
}

function wrap(text: string, width: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (word: string) => {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= width) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = "";
    // Hard-break words wider than the line (hashes, long paths).
    let rest = word;
    while (textWidth(rest, size, bold) > width) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) push(word);
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

interface Run {
  x: number;
  text: string;
  size: number;
  bold: boolean;
}
type Line = { runs: Run[]; height: number; spaceBefore: number };

function layout(blocks: ReportBlock[]): Line[] {
  const lines: Line[] = [];
  const add = (runs: Run[], height: number, spaceBefore = 0) =>
    lines.push({ runs, height, spaceBefore });
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = block.level === 1 ? 16 : block.level === 2 ? 12.5 : 10;
        const space = block.level === 1 ? 0 : block.level === 2 ? 14 : 6;
        wrap(block.text, CONTENT_WIDTH, size, true).forEach((text, i) =>
          add([{ x: MARGIN, text, size, bold: true }], size * 1.35, i === 0 ? space : 0),
        );
        break;
      }
      case "paragraph":
        wrap(block.text, CONTENT_WIDTH, 9.5, false).forEach((text, i) =>
          add([{ x: MARGIN, text, size: 9.5, bold: false }], 13, i === 0 ? 4 : 0),
        );
        break;
      case "list":
        for (const item of block.items) {
          wrap(item, CONTENT_WIDTH - 12, 9.5, false).forEach((text, i) =>
            add(
              [
                ...(i === 0 ? [{ x: MARGIN, text: "•", size: 9.5, bold: false }] : []),
                { x: MARGIN + 12, text, size: 9.5, bold: false },
              ],
              13,
              i === 0 ? 2 : 0,
            ),
          );
        }
        break;
      case "table": {
        const keyWidth = 130;
        for (const [key, value] of block.rows) {
          const keys = wrap(key, keyWidth - 8, 9, true);
          const values = wrap(value, CONTENT_WIDTH - keyWidth, 9, false);
          for (let i = 0; i < Math.max(keys.length, values.length); i++) {
            add(
              [
                ...(keys[i] ? [{ x: MARGIN, text: keys[i]!, size: 9, bold: true }] : []),
                ...(values[i]
                  ? [{ x: MARGIN + keyWidth, text: values[i]!, size: 9, bold: false }]
                  : []),
              ],
              12.5,
              i === 0 ? 2 : 0,
            );
          }
        }
        break;
      }
    }
  }
  return lines;
}

function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    const needed = line.spaceBefore + line.height;
    if (y - needed < MARGIN + 10 && pages.at(-1)!.length > 0) {
      pages.push([]);
      y = PAGE_HEIGHT - MARGIN;
      pages.at(-1)!.push({ ...line, spaceBefore: 0 });
      y -= line.height;
      continue;
    }
    pages.at(-1)!.push(line);
    y -= needed;
  }
  return pages;
}

function pageContent(lines: Line[], footer: string): string {
  const ops: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    y -= line.spaceBefore + line.height;
    for (const run of line.runs) {
      ops.push(
        `BT /${run.bold ? "F2" : "F1"} ${run.size} Tf ${run.x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(run.text)} Tj ET`,
      );
    }
  }
  ops.push(`0.4 g BT /F1 8 Tf ${MARGIN} ${FOOTER_Y} Td ${pdfString(footer)} Tj ET 0 g`);
  return ops.join("\n");
}

export function renderPdf(report: AuditReport, options: { title?: string } = {}): Uint8Array {
  const pages = paginate(layout(report.blocks));
  const title = options.title ?? report.title;
  const objects: string[] = [];
  const pageRefs = pages.map((_, i) => `${6 + i * 2} 0 R`);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title ${pdfString(title)} /Producer (AgentLedger) >>`;
  pages.forEach((lines, i) => {
    const content = pageContent(lines, `${report.title} | page ${i + 1} of ${pages.length}`);
    objects[6 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
    objects[7 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
