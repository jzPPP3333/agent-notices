import fs from 'node:fs';

const HEAD_READ_BYTES = 8 * 1024;
const TAIL_READ_BYTES = 96 * 1024;

/**
 * Detect whether an Antigravity transcript belongs to an internal subagent / worker session.
 * Top-level user conversations start with a USER_INPUT / USER_EXPLICIT entry, whereas
 * Antigravity subagents start with a SYSTEM_MESSAGE / SYSTEM dispatch from the parent agent.
 */
export function isAntigravitySubagentTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return false;
    const len = Math.min(stat.size, HEAD_READ_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, 0);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    let sawFirst = false;
    let firstIsSystem = false;
    let parsedCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      parsedCount++;
      if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
        return false;
      }
      if (!sawFirst) {
        sawFirst = true;
        if (entry.type === 'SYSTEM_MESSAGE' || entry.source === 'SYSTEM') {
          firstIsSystem = true;
        }
      }
      if (parsedCount >= 5) break;
    }

    return firstIsSystem;
  } catch {
    return false;
  }
}

export function cleanText(input, maxLength = 220) {
  if (!input) return '';
  let text = String(input)
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, ' · ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (text.length > maxLength) {
    text = text.slice(0, Math.max(10, maxLength - 1)).trimEnd() + '…';
  }
  return text;
}

/**
 * Fast tail reader for JSONL transcript files (Antigravity & Claude Code).
 * Only reads the last ~96KB to avoid memory spikes on massive conversations.
 */
export function readTranscriptTail(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    const raw = buf.toString('utf8');
    const lines = raw.split('\n');
    // If we sliced mid-line at the start, drop the first partial line
    if (start > 0 && lines.length > 1) {
      lines.shift();
    }
    const parsed = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        // skip partial/invalid JSON
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Extract the latest assistant text message from Antigravity or Claude Code transcript JSONL.
 */
export function extractLastAssistantText(transcriptPath) {
  const entries = readTranscriptTail(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;

    // Antigravity format: { type: "PLANNER_RESPONSE", content: "..." }
    if (entry.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string' && entry.content.trim()) {
      return entry.content.trim();
    }

    // Claude Code format: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
    if (entry.type === 'assistant' && entry.message) {
      const content = entry.message.content;
      if (typeof content === 'string' && content.trim()) {
        return content.trim();
      }
      if (Array.isArray(content)) {
        const texts = content
          .filter((blk) => blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim())
          .map((blk) => blk.text.trim());
        if (texts.length > 0) {
          return texts.join('\n');
        }
      }
    }

    // Generic fallback: { role: "assistant", content: "..." }
    if (entry.role === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) {
      return entry.content.trim();
    }
  }
  return '';
}

/**
 * Build a concise human-readable message from user prompt + assistant output (with optional LLM polish).
 */
export async function buildEventSummary({ userPrompt = '', assistantText = '', errorText = '', config }) {
  const maxLength = config?.summary?.maxLength ?? 220;

  if (errorText) {
    return cleanText(`错误：${errorText}`, maxLength);
  }

  let rawSummary = '';
  if (assistantText) {
    rawSummary = cleanText(assistantText, maxLength);
  } else if (userPrompt) {
    rawSummary = cleanText(`任务：${userPrompt}`, maxLength);
  } else {
    rawSummary = '当前会话回合已结束，可返回查看结果。';
  }

  // Optional LLM refinement when user enabled an OpenAI-compatible endpoint
  const llm = config?.summary?.llm;
  if (llm?.enabled && llm.apiKey && llm.baseUrl && (assistantText || userPrompt)) {
    try {
      const refined = await summarizeWithLLM({ userPrompt, assistantText, llm, maxLength });
      if (refined) return refined;
    } catch {
      // Fallback gracefully to offline summary
    }
  }

  return rawSummary;
}

async function summarizeWithLLM({ userPrompt, assistantText, llm, maxLength }) {
  const endpoint = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llm.timeoutMs || 4000);
  try {
    const prompt = [
      '请用 1~2 句简洁中文总结下面 AI 编程助手刚完成的任务结果（不超过 80 字，不要 Markdown 符号，直接输出结论）：',
      userPrompt ? `用户指令：${userPrompt.slice(0, 400)}` : '',
      assistantText ? `助手回复：${assistantText.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    return content ? cleanText(content, maxLength) : '';
  } finally {
    clearTimeout(timer);
  }
}
