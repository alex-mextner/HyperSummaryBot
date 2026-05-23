/** Table rendering utilities for Telegram-friendly output.
 *  Telegram Bot API does NOT support <table> tags, so we render
 *  aligned monospace tables inside <pre> blocks. */

export interface TableRow {
  [key: string]: string | number;
}

/** Render a structured table as a Telegram <pre> ASCII table.
 *  Falls back to a formatted list if columns are too wide. */
export function renderTable(headers: string[], rows: TableRow[]): string {
  if (rows.length === 0) return "<i>(пусто)</i>";

  // Extract cell values in column order
  const data: string[][] = rows.map((row) =>
    headers.map((h) => {
      const val = row[h];
      return val === undefined || val === null ? "" : String(val);
    }),
  );

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] !== undefined ? row[i].length : 0))),
  );

  const totalWidth = widths.reduce((a, b) => a + b + 3, 0); // " | " separators
  const maxTelegramWidth = 70; // Telegram <pre> looks good up to ~70 chars

  if (totalWidth > maxTelegramWidth) {
    // Too wide — render as labeled list instead
    return renderAsList(headers, rows);
  }

  // Build separator line: +---+---+
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  // Build header row
  const headerRow = "| " + headers.map((h, i) => padRight(h, widths[i]!)).join(" | ") + " |";

  // Build data rows
  const dataRows = data.map(
    (row) => "| " + row.map((cell, i) => padRight(cell, widths[i]!)).join(" | ") + " |",
  );

  const lines = [sep, headerRow, sep, ...dataRows, sep];
  return `<pre>${escapePre(lines.join("\n"))}</pre>`;
}

/** Render wide tables as a labeled list (more readable on mobile). */
function renderAsList(headers: string[], rows: TableRow[]): string {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    lines.push(`<b>${i + 1}.</b>`);
    for (const h of headers) {
      const row = rows[i];
      if (!row) continue;
      const val = row[h];
      if (val !== undefined && val !== null && String(val).trim()) {
        lines.push(`  <code>${escapeHtml(h)}</code>: ${escapeHtml(String(val))}`);
      }
    }
    if (i < rows.length - 1) lines.push("");
  }
  return lines.join("\n");
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape text inside <pre> — only need to handle HTML entities,
 *  Telegram preserves whitespace in <pre>. */
function escapePre(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert markdown tables (| col1 | col2 |) to <pre> ASCII tables.
 *  Handles header separator lines (|---|---|). */
export function markdownTableToHtml(text: string): string {
  // Match markdown table blocks: lines starting with |
  const tableRegex = /^(\|.*\|)[ \t]*(?:\n\|?[\s\-:|]+\|?)[ \t]*(?:\n\|.*\|.*)*$/gm;

  return text.replace(tableRegex, (block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return block;

    // First line is header, second is separator (skip), rest are data
    const headerLine = lines[0]!;
    const dataLines = lines.slice(2);

    const headers = parseMarkdownTableRow(headerLine);
    const rows = dataLines.map(parseMarkdownTableRow);

    // Build as objects for renderTable
    const rowObjects = rows.map((cells) => {
      const obj: TableRow = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (key !== undefined) {
          obj[key] = cells[i] ?? "";
        }
      }
      return obj;
    });

    return renderTable(headers, rowObjects);
  });
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1) // Remove leading/trailing empty cells from outer pipes
    .map((cell) => cell.trim());
}
