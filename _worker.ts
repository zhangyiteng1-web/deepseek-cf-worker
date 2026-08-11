/**
 * Cloudflare Pages Worker - DeepSeek API 代理
 * 单文件自包含，无需额外模块导入
 */
import { sha3_512 } from '@noble/hashes/sha3';

// ====== 类型定义 ======
interface Env {
  DEEPSEEK_USER_TOKEN?: string;
  DEEPSEEK_USER_TOKENS?: string;
  API_KEY?: string;
}

interface PowChallenge {
  algorithm: { name: string; version: number };
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

interface PowAnswer {
  algorithm: { name: string; version: number };
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
  target_path: string;
}

interface SessionCache {
  sessionId: string;
  createdAt: number;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

// ====== 常量 ======
const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api';
const DEFAULT_HEADERS: Record<string, string> = {
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

// ====== 工具函数 ======
function uuidv4(): string { return crypto.randomUUID(); }
function now(): number { return Math.floor(Date.now() / 1000); }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function pickToken(tokens: string): string {
  const list = tokens.split(',').map(t => t.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('No valid tokens');
  return list[Math.floor(Math.random() * list.length)];
}

function messagesToPrompt(messages: any[]): string {
  const processed = messages.map((msg: any) => {
    const role = msg.role;
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text ?? '')
        .join('\n');
    }
    if (role === 'tool' && msg.tool_call_id) {
      content = `<tool_response tool_call_id="${msg.tool_call_id}">\n${content}\n</tool_response>`;
    }
    if (role === 'assistant' && msg.tool_calls) {
      const calls = msg.tool_calls.map((tc: any) =>
        `<tool_calling>\n<name>${tc.function.name}</name>\n<arguments>${tc.function.arguments}</arguments>\n</tool_calling>`
      );
      content = calls.join('\n');
    }
    return { role, text: content };
  });

  const merged: Array<{ role: string; text: string }> = [];
  for (const msg of processed) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.text += '\n\n' + msg.text;
    } else {
      merged.push({ ...msg });
    }
  }

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
  return parts.join('').replace(/!\[.*?\]\(.*?\)/g, '');
}

function mapModelType(model: string): 'default' | 'expert' {
  const lower = model.toLowerCase();
  if (lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1')) return 'expert';
  return 'default';
}

function shouldEnableThinking(model: string, thinking?: { type: string }, reasoningEffort?: string): boolean {
  if (thinking?.type === 'enabled') return true;
  if (thinking?.type === 'disabled') return false;
  if (reasoningEffort) return true;
  const lower = model.toLowerCase();
  if (lower.includes('-think')) return true;
  if (lower.includes('-fast')) return false;
  return lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1');
}

// ====== POW 求解器 ======
function hash(input: string): Uint8Array {
  return sha3_512(new TextEncoder().encode(input));
}

function countLeadingZeroBits(hashBytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < hashBytes.length; i++) {
    if (hashBytes[i] === 0) { count += 8; continue; }
    let b = hashBytes[i];
    while ((b & 0x80) === 0) { count++; b <<= 1; }
    break;
  }
  return count;
}

function solvePow(challenge: PowChallenge): PowAnswer {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge;
  const prefix = `${salt}_${expire_at}_`;
  for (let nonce = 0; nonce < 500000; nonce++) {
    const input = prefix + challengeStr + nonce.toString();
    const hashBytes = hash(input);
    const zeros = countLeadingZeroBits(hashBytes);
    if (zeros >= difficulty) {
      return { algorithm, challenge: challengeStr, salt, answer: nonce, signature, target_path: '/api/v0/chat/completion' };
    }
  }
  throw new Error('POW failed: exceeded max iterations');
}

function encodePowAnswer(answer: PowAnswer): string {
  const json = JSON.stringify(answer);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes));
}

// ====== 认证模块 ======
let tokenCache: TokenCache | null = null;

function getUserToken(env: Env): string {
  if (env.DEEPSEEK_USER_TOKENS) return pickToken(env.DEEPSEEK_USER_TOKENS);
  if (env.DEEPSEEK_USER_TOKEN) return env.DEEPSEEK_USER_TOKEN.trim();
  throw new Error('DEEPSEEK_USER_TOKEN 未配置');
}

async function getAccessToken(env: Env): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > now() + 300) return tokenCache.accessToken;
  const userToken = getUserToken(env);
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
    headers: { ...DEFAULT_HEADERS, 'Authorization': `Bearer ${userToken}` },
  });
  if (!resp.ok) throw new Error(`Token refresh failed: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const bizData = data?.data?.biz_data || data?.biz_data;
  if (!bizData?.token) throw new Error('Token refresh failed: no token in response');
  tokenCache = { accessToken: bizData.token, expiresAt: now() + 3600 };
  return tokenCache.accessToken;
}

// ====== 会话管理 ======
const sessionCache = new Map<string, SessionCache>();

async function createSession(env: Env): Promise<SessionCache> {
  const token = await getAccessToken(env);
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ character_id: null }),
  });
  if (!resp.ok) throw new Error(`Session create failed: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const bizData = data?.data?.biz_data || data?.biz_data;
  const sessionId = bizData?.chat_session?.id || bizData?.id;
  if (!sessionId) throw new Error('No session ID in response');
  const session = { sessionId, createdAt: now() };
  sessionCache.set(sessionId, session);
  return session;
}

async function getOrCreateSession(env: Env): Promise<SessionCache> {
  for (const [, s] of sessionCache) {
    if (now() - s.createdAt < 300) return s;
  }
  return createSession(env);
}

async function getPowChallenge(env: Env): Promise<PowChallenge> {
  const token = await getAccessToken(env);
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  if (!resp.ok) throw new Error(`POW challenge failed: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const bizData = data?.data?.biz_data || data?.biz_data;
  if (!bizData?.challenge) throw new Error('No POW challenge in response');
  return bizData.challenge as PowChallenge;
}

// ====== 聊天代理 ======
async function handleChatCompletion(body: any, env: Env): Promise<Response> {
  try {
    const session = await getOrCreateSession(env);
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    const powHeader = encodePowAnswer(powAnswer);
    const token = await getAccessToken(env);

    const prompt = messagesToPrompt(body.messages);
    const modelType = mapModelType(body.model);
    const thinkingEnabled = shouldEnableThinking(body.model, body.thinking, body.reasoning_effort);

    const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
        'X-Ds-Pow-Response': powHeader,
      },
      body: JSON.stringify({
        chat_session_id: session.sessionId,
        parent_message_id: null,
        model_type: modelType,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingEnabled,
        search_enabled: body.web_search ?? false,
        preempt: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Chat failed: HTTP ${resp.status} - ${errText}`);
    }

    const text = await resp.text();
    const lines = text.split('\n');
    const contents: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === 'text' && d.content) contents.push(d.content);
        } catch {}
      }
    }

    return jsonResponse({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: now(),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: contents.join('') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e: any) {
    return jsonResponse({ error: { message: e.message, type: 'server_error' } }, 500);
  }
}

async function handleStreamCompletion(body: any, env: Env): Promise<Response> {
  try {
    const session = await getOrCreateSession(env);
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    const powHeader = encodePowAnswer(powAnswer);
    const token = await getAccessToken(env);

    const prompt = messagesToPrompt(body.messages);
    const modelType = mapModelType(body.model);
    const thinkingEnabled = shouldEnableThinking(body.model, body.thinking, body.reasoning_effort);

    const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
        'X-Ds-Pow-Response': powHeader,
      },
      body: JSON.stringify({
        chat_session_id: session.sessionId,
        parent_message_id: null,
        model_type: modelType,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingEnabled,
        search_enabled: body.web_search ?? false,
        preempt: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Chat failed: HTTP ${resp.status} - ${errText}`);
    }
    if (!resp.body) throw new Error('No response body');

    const chatId = `chatcmpl-${uuidv4()}`;
    const model = body.model;
    let buffer = '';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = resp.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const d = JSON.parse(line.slice(6));
                if (d.content && (d.type === 'text' || d.type === 'thinking')) {
                  const delta: any = {};
                  if (d.type === 'text') delta.content = d.content;
                  else delta.reasoning_content = d.content;
                  const chunk = { id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta, finish_reason: null }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch {}
            }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (e: any) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: e.message } })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
          reader.releaseLock();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e: any) {
    return jsonResponse({ error: { message: e.message, type: 'server_error' } }, 500);
  }
}

// ====== HTML 页面 ======
function serveHomePage(): Response {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Cloudflare Worker API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 720px; width: 100%; background: #1e293b; border-radius: 16px; padding: 40px; box-shadow: 0 25px 50px rgba(0,0,0,0.3); }
    h1 { font-size: 28px; margin-bottom: 8px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
    .section { margin-bottom: 28px; }
    .section h2 { font-size: 18px; color: #f1f5f9; margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    .endpoint { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .method { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-right: 8px; }
    .post { background: #166534; color: #4ade80; }
    .get { background: #1e3a5f; color: #60a5fa; }
    .path { font-family: 'Menlo', 'Consolas', monospace; color: #e2e8f0; font-size: 14px; }
    .desc { color: #94a3b8; font-size: 13px; margin-top: 6px; }
    pre { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 13px; line-height: 1.6; color: #e2e8f0; }
    .comment { color: #64748b; }
    .key { color: #93c5fd; }
    .str { color: #86efac; }
    .models { display: flex; flex-wrap: wrap; gap: 8px; }
    .model-tag { background: #334155; color: #e2e8f0; padding: 4px 12px; border-radius: 20px; font-size: 13px; }
    .status { display: flex; align-items: center; gap: 8px; margin-top: 24px; color: #4ade80; font-size: 14px; }
    .dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>DeepSeek Cloudflare Worker</h1>
    <p class="subtitle">OpenAI 兼容的 DeepSeek Web Chat API 代理 · 部署在 Cloudflare 边缘网络</p>
    <div class="section">
      <h2>接口列表</h2>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/v1/chat/completions</span><p class="desc">OpenAI 兼容的聊天完成接口，支持流式和非流式</p></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/v1/models</span><p class="desc">获取可用模型列表</p></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/health</span><p class="desc">健康检查</p></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/get-token.html</span><p class="desc">获取 userToken 工具页</p></div>
    </div>
    <div class="section">
      <h2>支持模型</h2>
      <div class="models">
        <span class="model-tag">deepseek-v4-flash</span><span class="model-tag">deepseek-v4-pro</span><span class="model-tag">deepseek-r1</span><span class="model-tag">deepseek-chat</span><span class="model-tag">deepseek-reasoner</span>
      </div>
    </div>
    <div class="section">
      <h2>快速使用</h2>
      <pre><span class="comment"># cURL</span>
curl -X POST https://<span class="key">your-domain</span>/v1/chat/completions \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'</span>

<span class="comment"># Python (OpenAI SDK)</span>
<span class="key">from</span> openai <span class="key">import</span> OpenAI
client = OpenAI(base_url=<span class="str">"https://your-domain/v1"</span>, api_key=<span class="str">"any"</span>)
response = client.chat.completions.create(model=<span class="str">"deepseek-v4-flash"</span>, messages=[{<span class="str">"role"</span>: <span class="str">"user"</span>, <span class="str">"content"</span>: <span class="str">"Hello"</span>}])</pre>
    </div>
    <div class="status"><div class="dot"></div><span>服务运行中 · Cloudflare Edge Network</span></div>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function serveTokenPage(): Response {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>获取 DeepSeek userToken</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 32px 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
    h1 { font-size: 22px; color: #38bdf8; margin-bottom: 6px; text-align: center; }
    .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 28px; text-align: center; }
    .step { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
    .step-num { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: #2563eb; color: #fff; border-radius: 50%; font-size: 13px; font-weight: 700; margin-right: 8px; }
    .step-title { font-size: 15px; font-weight: 600; color: #f1f5f9; margin-bottom: 8px; }
    .step p { color: #94a3b8; font-size: 13px; line-height: 1.6; }
    a { color: #38bdf8; }
    .code-block { background: #0f172a; border: 1px solid #475569; border-radius: 8px; padding: 14px; margin: 12px 0; font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; color: #86efac; word-break: break-all; line-height: 1.5; max-height: 120px; overflow-y: auto; position: relative; }
    .copy-btn { position: absolute; top: 8px; right: 8px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
    .copy-btn.copied { background: #166534; color: #4ade80; }
    .btn { display: block; width: 100%; padding: 14px; margin: 8px 0; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; text-align: center; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-outline { background: transparent; border: 2px solid #334155; color: #e2e8f0; }
    .result-box { background: #0f172a; border: 2px solid #4ade80; border-radius: 10px; padding: 16px; margin-top: 16px; display: none; }
    .result-box.show { display: block; }
    .result-box .label { color: #4ade80; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .result-box .token { font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; color: #86efac; word-break: break-all; line-height: 1.5; }
    .tip { background: #1e293b; border-left: 3px solid #f59e0b; border-radius: 6px; padding: 12px; margin-top: 20px; font-size: 12px; color: #fcd34d; line-height: 1.6; }
    .warning { background: #450a0a; border: 1px solid #dc2626; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 12px; color: #fca5a5; line-height: 1.6; }
    textarea { width: 100%; height: 80px; background: #0f172a; border: 1px solid #475569; border-radius: 8px; padding: 12px; color: #e2e8f0; font-size: 12px; margin-top: 8px; resize: vertical; font-family: Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <div class="container">
    <h1>获取 DeepSeek userToken</h1>
    <p class="subtitle">用于 Cloudflare Worker API 代理</p>

    <div class="step">
      <span class="step-num">1</span>
      <span class="step-title">电脑端（推荐）</span>
      <p>用电脑浏览器打开 <a href="https://chat.deepseek.com" target="_blank">chat.deepseek.com</a> 并登录，然后按 <b>F12</b> → <b>Application</b> → <b>Local Storage</b> → <b>chat.deepseek.com</b> → 复制 <b>userToken</b> 的值。</p>
    </div>

    <div class="step">
      <span class="step-num">2</span>
      <span class="step-title">手机端：书签脚本法</span>
      <p>① 先打开 <b>chat.deepseek.com</b> 并登录</p>
      <p style="margin-top:8px;">② <b>添加书签</b>：浏览器菜单 → 添加书签 → 名称随意，网址粘贴下方代码 → 保存</p>
      <p style="margin-top:4px;">③ 在 chat.deepseek.com 页面<b>点击该书签</b>即可弹出 Token</p>
      <div class="code-block" style="position:relative;">
        <button class="copy-btn" id="copyScriptBtn" onclick="copyScript()">复制</button>
        <code id="scriptCode">(function(){var t=localStorage.getItem('userToken');if(t){var e=document.createElement('div');e.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';var n=document.createElement('div');n.style.cssText='background:#1e293b;border-radius:16px;padding:24px;width:100%;max-width:500px;text-align:center;';n.innerHTML='<h2 style="color:#4ade80;margin-bottom:12px;">Token 获取成功</h2><div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:16px;word-break:break-all;font-size:12px;color:#86efac;text-align:left;max-height:200px;overflow-y:auto;" id="ds-token">'+t+'</div><button style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;margin:4px;cursor:pointer;" onclick="navigator.clipboard.writeText(this.parentElement.querySelector(\\'#ds-token\\').textContent).then(function(){this.textContent=\\'已复制\\';this.style.background=\\'#166534\\'}.bind(this))">复制 Token</button>';e.appendChild(n);document.body.appendChild(e)}else{alert('未找到 userToken')}})();</code>
      </div>
    </div>

    <div class="step">
      <span class="step-num">3</span>
      <span class="step-title">验证 Token</span>
      <p>粘贴 token 到下方，点击验证：</p>
      <textarea id="tokenInput" placeholder="粘贴你的 userToken（以 eyJ... 开头）"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary" onclick="verifyToken()" style="flex:1;">验证 Token</button>
        <button class="btn btn-outline" onclick="copyToken()" style="flex:1;">复制 Token</button>
      </div>
      <div id="verifyResult" class="result-box"></div>
    </div>

    <div class="tip"><b>提示：</b>userToken 是以 <b>eyJhbGciOiJIUzUxMiIs...</b> 开头的长字符串。</div>
    <div class="warning"><b>安全提醒：</b>Token 相当于密码，<b>不要分享给任何人</b>。</div>
  </div>

  <script>
    function copyScript() {
      var code = document.getElementById('scriptCode').textContent;
      navigator.clipboard.writeText(code).then(function() {
        var btn = document.getElementById('copyScriptBtn');
        btn.textContent = '已复制'; btn.classList.add('copied');
        setTimeout(function() { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
      }).catch(function() { alert('复制失败，请手动长按选择复制'); });
    }
    function copyToken() {
      var token = document.getElementById('tokenInput').value.trim();
      if (!token) { alert('请先粘贴 token'); return; }
      navigator.clipboard.writeText(token).then(function() { alert('Token 已复制'); }).catch(function() { alert('复制失败'); });
    }
    async function verifyToken() {
      var token = document.getElementById('tokenInput').value.trim();
      var resultBox = document.getElementById('verifyResult');
      if (!token) { resultBox.className = 'result-box show'; resultBox.innerHTML = '<div class="label">请输入 token</div>'; return; }
      resultBox.className = 'result-box show';
      resultBox.innerHTML = '<div class="label">正在验证...</div>';
      try {
        var resp = await fetch('https://chat.deepseek.com/api/v0/users/current', { headers: { 'Authorization': 'Bearer ' + token, 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' } });
        if (resp.ok) {
          var data = await resp.json();
          var email = (data && data.data && data.data.biz_data && data.data.biz_data.user && data.data.biz_data.user.email) || '未知';
          resultBox.innerHTML = '<div class="label">Token 有效！</div><div class="token" style="margin-bottom:8px;">账号：' + email + '</div>';
        } else {
          resultBox.innerHTML = '<div class="label">Token 无效</div><div class="token" style="color:#fca5a5;">HTTP ' + resp.status + '</div>';
        }
      } catch (e) {
        resultBox.innerHTML = '<div class="label">网络错误</div><div class="token" style="color:#fca5a5;">无法连接到 DeepSeek</div>';
      }
    }
  </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ====== 主入口 ======
const MODELS = [
  { id: 'deepseek-v4-flash', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-flash-think', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-pro', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-pro-think', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-r1', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-chat', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', created: 1735680000, owned_by: 'deepseek' },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // API Key 仅对 API 路由生效，公开页面不受限
    const isApiRoute = path === '/v1/chat/completions' || path === '/v1/models';
    if (isApiRoute && env.API_KEY) {
      const auth = request.headers.get('Authorization') || '';
      const providedKey = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      if (providedKey !== env.API_KEY) {
        return jsonResponse({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401);
      }
    }

    try {
      if (path === '/health') return jsonResponse({ status: 'ok', timestamp: Date.now() });
      if (path === '/v1/models') return jsonResponse({ object: 'list', data: MODELS });
      if (path === '/get-token.html') return serveTokenPage();
      if (path === '/') return serveHomePage();

      if (path === '/v1/chat/completions') {
        if (request.method !== 'POST') return jsonResponse({ error: { message: 'Method not allowed', type: 'invalid_request_error' } }, 405);

        let body: any;
        try { body = await request.json(); } catch {
          return jsonResponse({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
        }
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          return jsonResponse({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400);
        }
        if (!body.model) body.model = 'deepseek-v4-flash';

        if (body.stream) return handleStreamCompletion(body, env);
        return handleChatCompletion(body, env);
      }

      return jsonResponse({ error: { message: 'Not found', type: 'not_found_error' } }, 404);
    } catch (e: any) {
      return jsonResponse({ error: { message: e.message || 'Internal error', type: 'server_error' } }, 500);
    }
  },
};