/**
 * 工具函数
 */

import type { OpenAIMessage } from './types';

/** DeepSeek API 基础 URL */
export const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api';

/** 默认请求头 */
export const DEFAULT_HEADERS: Record<string, string> = {
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  'Origin': 'https://chat.deepseek.com',
  'Referer': 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'X-App-Version': '20241129.1',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '1.8.0',
};

/** 生成 UUID v4 */
export function uuidv4(): string {
  return crypto.randomUUID();
}

/** 获取当前时间戳（秒） */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 将 OpenAI 消息列表转换为 DeepSeek prompt 格式
 * chat.deepseek.com 使用特殊的 prompt 格式
 */
export function messagesToPrompt(messages: OpenAIMessage[]): string {
  const processed = messages.map((msg) => {
    const role = msg.role;
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
    }

    if (role === 'tool' && msg.tool_call_id) {
      content = `<tool_response tool_call_id="${msg.tool_call_id}">\n${content}\n</tool_response>`;
    }

    if (role === 'assistant' && msg.tool_calls) {
      const calls = msg.tool_calls.map(
        (tc) =>
          `<tool_calling>\n<name>${tc.function.name}</name>\n<arguments>${tc.function.arguments}</arguments>\n</tool_calling>`
      );
      content = calls.join('\n');
    }

    return { role, text: content };
  });

  // 合并连续相同角色的消息
  const merged: Array<{ role: string; text: string }> = [];
  for (const msg of processed) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.text += '\n\n' + msg.text;
    } else {
      merged.push({ ...msg });
    }
  }

  // 构建 prompt
  const parts: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const block = merged[i];
    if (block.role === 'assistant') {
      parts.push(`<｜Assistant｜>${block.text}<｜end of sentence｜>`);
    } else if (block.role === 'user' || block.role === 'system') {
      parts.push(i === 0 ? block.text : `用户${block.text}`);
    } else if (block.role === 'tool') {
      parts.push(`用户${block.text}`);
    }
  }

  // 清理 Markdown 图片语法
  return parts.join('').replace(/!\[.*?\]\(.*?\)/g, '');
}

/**
 * 模型名称映射：OpenAI 模型名 -> DeepSeek 内部模型类型
 */
export function mapModelType(model: string): 'default' | 'expert' {
  const lower = model.toLowerCase();
  if (lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1')) {
    return 'expert';
  }
  return 'default';
}

/**
 * 判断是否启用思考模式
 */
export function shouldEnableThinking(model: string, thinking?: { type: string }, reasoningEffort?: string): boolean {
  if (thinking?.type === 'enabled') return true;
  if (thinking?.type === 'disabled') return false;
  if (reasoningEffort) return true;
  const lower = model.toLowerCase();
  if (lower.includes('-think')) return true;
  if (lower.includes('-fast')) return false;
  // Pro 模型默认开启思考
  return lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1');
}

/**
 * 从多个 token 中随机选择一个（负载均衡）
 */
export function pickToken(tokens: string): string {
  const list = tokens.split(',').map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('No valid tokens');
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 创建标准 JSON 响应
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

/**
 * 创建 SSE 流式响应
 */
export function streamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    },
  });
}