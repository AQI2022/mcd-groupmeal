/**
 * MCP 返回体的 JSON 提取器。
 *
 * 麦当劳 MCP Server 的工具返回并不是纯 JSON，而是「markdown 说明 + 内嵌 JSON + 尾随说明」
 * 的混合文本，并且 markdown 说明里本身含 `{序号}`、`{data[].storeCode}` 这类花括号占位符。
 *
 * 因此：
 *   - 不能用 first-`{` .. last-`}` 切片（markdown 的花括号会污染切片）；
 *   - 也不能假设 JSON 在字符串末尾（实测 `delivery-query-stores` 的 JSON 后面还有文字）。
 *
 * 正确做法是扫描每个 `{` 起点，用平衡花括号找到匹配的 `}`，再尝试 JSON.parse。
 */

/** 从 `start`（必须是 `{`）开始找配对的 `}`，正确跳过字符串与转义。找不到返回 -1。 */
export function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从混合文本中提取内嵌 JSON 对象。
 * 优先返回含 `success` / `code` / `data` 的对象（业务响应）；
 * 找不到时返回第一个能解析出来的对象；完全没有则返回 null。
 */
export function extractJson(text) {
  const s = String(text ?? '');
  try {
    const direct = JSON.parse(s);
    if (direct && typeof direct === 'object') return direct;
  } catch {
    /* 混合文本，继续按花括号扫描 */
  }

  let fallback = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end < 0) continue;
    let candidate;
    try {
      candidate = JSON.parse(s.slice(i, end + 1));
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    if ('success' in candidate || 'code' in candidate || 'data' in candidate) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback;
}

/** 把 MCP 的 content[] 数组拼成纯文本。 */
export function contentToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
    .join('\n');
}
