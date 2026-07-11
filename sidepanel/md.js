// Minimal, safe Markdown renderer (no external libraries).
// First escapes HTML, then applies formatting.

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  // code `...`
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold and italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  // bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return s;
}

export function renderMarkdown(text) {
  if (!text) return "";
  const lines = esc(String(text)).split("\n");
  const out = [];
  let inCode = false, codeLang = "", codeBuf = [];
  let listType = null; // "ul" | "ol"
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; }
  };
  const flushList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const raw of lines) {
    const line = raw;

    if (/^```/.test(line.trim())) {
      if (!inCode) {
        flushPara(); flushList();
        inCode = true; codeLang = line.trim().slice(3).trim(); codeBuf = [];
      } else {
        out.push(`<pre data-lang="${codeLang}"><code>${codeBuf.join("\n")}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }

    if (/^\s*([-*+])\s+/.test(line)) {
      flushPara();
      if (listType !== "ul") { flushList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      if (listType !== "ol") { flushList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`);
      continue;
    }
    // Markdown table support
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      // Check if next line is a separator row
      const nextLine = lines[lines.indexOf(raw) + 1];
      if (nextLine && /^\s*\|?[\s:-]+\|/.test(nextLine)) {
        // Parse table header
        const headers = line.split("|").map((c) => c.trim()).filter(Boolean);
        let tableHtml = "<table><thead><tr>";
        for (const h of headers) tableHtml += `<th>${inline(h)}</th>`;
        tableHtml += "</tr></thead><tbody>";
        // Skip separator line and parse body
        lines[lines.indexOf(raw) + 1] = ""; // consume separator
        out.push(tableHtml);
        continue;
      }
      // Table body row
      if (out.length && out[out.length - 1].includes("<tbody>")) {
        const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
        let rowHtml = "<tr>";
        for (const c of cells) rowHtml += `<td>${inline(c)}</td>`;
        rowHtml += "</tr>";
        // Append to last table
        const lastIdx = out.length - 1;
        out[lastIdx] = out[lastIdx].replace("</tbody>", rowHtml + "</tbody></table>");
        continue;
      }
      // Close table if we see a non-table line after rows
    }
    // Close any open table
    if (out.length && out[out.length - 1].includes("<tbody>") && !out[out.length - 1].endsWith("</table>")) {
      out[out.length - 1] += "</tbody></table>";
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }

    if (line.trim() === "") { flushPara(); flushList(); continue; }
    para.push(line);
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  flushPara(); flushList();
  return out.join("");
}
