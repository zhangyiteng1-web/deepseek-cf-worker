// ====== DeepSeekHashV1 = SHA3-256 变体: 23 rounds (skip round 0), SHA3 padding ======
const DS_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const DS_RHOS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const DS_ROTL = (v, n) => ((v << n) | (v >> (64n - n))) & 0xFFFFFFFFFFFFFFFFn;

// DeepSeekHashV1: Keccak-f[1600] rounds 1..23 (skip round 0, use RC[1]..RC[23])
function keccakF_ds(state) {
  for (let r = 1; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map(x => state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20]);
    const D = [0, 1, 2, 3, 4].map(x => C[(x+4)%5] ^ DS_ROTL(C[(x+1)%5], 1n));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x+5*y] ^= D[x];
    let cur = state[1], cx = 1, cy = 0;
    for (let t = 0; t < 24; t++) {
      const nx = cy, ny = (2*cx + 3*cy) % 5;
      const tmp = state[nx + 5*ny];
      state[nx + 5*ny] = DS_ROTL(cur, BigInt(DS_RHOS[cx + 5*cy]));
      cur = tmp; cx = nx; cy = ny;
    }
    for (let y = 0; y < 5; y++) {
      const T = [0, 1, 2, 3, 4].map(x => state[x+5*y]);
      for (let x = 0; x < 5; x++) state[x+5*y] = T[x] ^ ((~T[(x+1)%5]) & T[(x+2)%5]);
    }
    state[0] ^= DS_RC[r];
  }
}

// SHA3-256 padding (0x06), rate=136, output=32 bytes
function deepseekHashV1(bytes) {
  const rate = 136, outLen = 32;
  const state = new Array(25).fill(0n);
  let i = 0;
  while (i + rate <= bytes.length) {
    for (let j = 0; j < rate; j++) {
      const wi = (j >> 3), bi = j & 7;
      state[wi] ^= BigInt(bytes[i + j]) << BigInt(bi << 3);
    }
    keccakF_ds(state);
    i += rate;
  }
  const rem = bytes.length - i;
  for (let j = 0; j < rem; j++) {
    const wi = (j >> 3), bi = j & 7;
    state[wi] ^= BigInt(bytes[i + j]) << BigInt(bi << 3);
  }
  // SHA3 padding: 0x06 + 0x00... + 0x80
  state[(rem >> 3)] ^= 0x06n << BigInt((rem & 7) << 3);
  state[(rate - 1) >> 3] ^= 0x80n << BigInt(((rate - 1) & 7) << 3);
  keccakF_ds(state);
  const out = new Uint8Array(outLen);
  for (let j = 0; j < outLen; j++) {
    out[j] = Number((state[(j >> 3)] >> BigInt((j & 7) << 3)) & 0xFFn);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xF).toString(16);
  }
  return hex;
}

// ====== 常量 ======
const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api';
const DEFAULT_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  'Origin': 'https://chat.deepseek.com',
  'Referer': 'https://chat.deepseek.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'X-App-Version': '20241129.1',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '1.8.0',
};

// ====== 工具函数 ======
function uuidv4() { return crypto.randomUUID(); }
function now() { return Math.floor(Date.now() / 1000); }

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function pickToken(tokens) {
  const list = tokens.split(',').map(t => t.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('No valid tokens');
  return list[Math.floor(Math.random() * list.length)];
}

function messagesToPrompt(messages) {
  const processed = messages.map(msg => {
    const role = msg.role;
    let content = '';
    if (typeof msg.content === 'string') content = msg.content;
    else if (Array.isArray(msg.content)) {
      content = msg.content.filter(item => item.type === 'text').map(item => item.text || '').join('\n');
    }
    if (role === 'tool' && msg.tool_call_id) {
      content = '<tool_response tool_call_id="' + msg.tool_call_id + '">\n' + content + '\n</tool_response>';
    }
    if (role === 'assistant' && msg.tool_calls) {
      content = msg.tool_calls.map(tc =>
        '<tool_calling>\n<name>' + tc.function.name + '</name>\n<arguments>' + tc.function.arguments + '</arguments>\n</tool_calling>'
      ).join('\n');
    }
    return { role, text: content };
  });
  const merged = [];
  for (const msg of processed) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.text += '\n\n' + msg.text;
    else merged.push({ ...msg });
  }
  const parts = [];
  for (let i = 0; i < merged.length; i++) {
    const block = merged[i];
    if (block.role === 'assistant') parts.push('<｜Assistant｜>' + block.text + '<｜end of sentence｜>');
    else if (block.role === 'user' || block.role === 'system') parts.push(i === 0 ? block.text : '用户' + block.text);
    else if (block.role === 'tool') parts.push('用户' + block.text);
  }
  return parts.join('').replace(/!\[.*?\]\(.*?\)/g, '');
}

function mapModelType(model) {
  const lower = model.toLowerCase();
  if (lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1')) return 'expert';
  return 'default';
}

function shouldEnableThinking(model, thinking, reasoningEffort) {
  if (thinking && thinking.type === 'enabled') return true;
  if (thinking && thinking.type === 'disabled') return false;
  if (reasoningEffort) return true;
  const lower = model.toLowerCase();
  if (lower.includes('-think')) return true;
  if (lower.includes('-fast')) return false;
  return lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1');
}

// ====== POW 求解器 (DeepSeekHashV1) ======
// Input: salt_expire_at_nonce, find nonce where hash == challenge hex
// Optimization: pre-compute partial hash for the constant prefix
function solvePow(challenge) {
  const { algorithm, challenge: challengeHex, salt, difficulty, expire_at, signature } = challenge;
  const prefix = salt + '_' + expire_at + '_';
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(prefix);
  const targetHex = challengeHex.toLowerCase();
  
  // Pre-compute state after absorbing all full blocks of prefix
  const rate = 136;
  const baseState = new Array(25).fill(0n);
  let pos = 0;
  while (pos + rate <= prefixBytes.length) {
    for (let j = 0; j < rate; j++) {
      const wi = (j >> 3), bi = j & 7;
      baseState[wi] ^= BigInt(prefixBytes[pos + j]) << BigInt(bi << 3);
    }
    keccakF_ds(baseState);
    pos += rate;
  }
  const rem = prefixBytes.length - pos;
  
  for (let nonce = 0; nonce <= difficulty; nonce++) {
    // Clone base state
    const state = baseState.slice();
    
    // Absorb remaining prefix + nonce + padding
    let p = 0;
    // Remaining prefix bytes
    for (let j = 0; j < rem; j++) {
      const wi = ((pos + p) >> 3), bi = (pos + p) & 7;
      state[wi] ^= BigInt(prefixBytes[pos + j]) << BigInt(bi << 3);
      p++;
    }
    // Nonce digits as ASCII
    const nonceStr = String(nonce);
    const nonceBytes = encoder.encode(nonceStr);
    for (let j = 0; j < nonceBytes.length; j++) {
      const wi = ((pos + p) >> 3), bi = (pos + p) & 7;
      state[wi] ^= BigInt(nonceBytes[j]) << BigInt(bi << 3);
      p++;
    }
    // SHA3 padding
    const padPos = pos + p;
    const padWi = (padPos >> 3), padBi = padPos & 7;
    state[padWi] ^= 0x06n << BigInt(padBi << 3);
    // Final padding byte at end of rate
    state[(rate - 1) >> 3] ^= 0x80n << BigInt(((rate - 1) & 7) << 3);
    
    keccakF_ds(state);
    
    // Extract hash bytes
    const hash = new Uint8Array(32);
    for (let j = 0; j < 32; j++) {
      hash[j] = Number((state[(j >> 3)] >> BigInt((j & 7) << 3)) & 0xFFn);
    }
    if (bytesToHex(hash) === targetHex) {
      return { algorithm, challenge: challengeHex, salt, answer: nonce, signature, target_path: '/api/v0/chat/completion' };
    }
  }
  throw new Error('POW failed: exceeded difficulty ' + difficulty);
}

function encodePowAnswer(answer) {
  const json = JSON.stringify(answer);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ====== 认证模块 ======
let tokenCache = null;

function getUserToken(env) {
  if (env.DEEPSEEK_USER_TOKENS) return pickToken(env.DEEPSEEK_USER_TOKENS);
  if (env.DEEPSEEK_USER_TOKEN) return env.DEEPSEEK_USER_TOKEN.trim();
  throw new Error('DEEPSEEK_USER_TOKEN not configured');
}

async function getAccessToken(env) {
  if (tokenCache && tokenCache.expiresAt > now() + 300) return tokenCache.accessToken;
  const userToken = getUserToken(env);
  const resp = await fetch(DEEPSEEK_API_BASE + '/v0/users/current', {
    headers: { ...DEFAULT_HEADERS, 'Authorization': 'Bearer ' + userToken },
  });
  if (!resp.ok) throw new Error('Token refresh failed: HTTP ' + resp.status);
  const data = await resp.json();
  const bizData = (data && data.data && data.data.biz_data) || (data && data.biz_data);
  if (!bizData || !bizData.token) throw new Error('Token refresh failed: no token');
  tokenCache = { accessToken: bizData.token, expiresAt: now() + 3600 };
  return tokenCache.accessToken;
}

// ====== 会话管理 ======
const sessionCache = new Map();

async function createSession(env) {
  const token = await getAccessToken(env);
  const resp = await fetch(DEEPSEEK_API_BASE + '/v0/chat_session/create', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ character_id: null }),
  });
  if (!resp.ok) throw new Error('Session create failed: HTTP ' + resp.status);
  const data = await resp.json();
  const bizData = (data && data.data && data.data.biz_data) || (data && data.biz_data);
  const sessionId = (bizData && bizData.chat_session && bizData.chat_session.id) || (bizData && bizData.id);
  if (!sessionId) throw new Error('No session ID in response');
  const session = { sessionId, createdAt: now() };
  sessionCache.set(sessionId, session);
  return session;
}

async function getOrCreateSession(env) {
  for (const [, s] of sessionCache) {
    if (now() - s.createdAt < 300) return s;
  }
  return createSession(env);
}

async function getPowChallenge(env) {
  const token = await getAccessToken(env);
  const resp = await fetch(DEEPSEEK_API_BASE + '/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  if (!resp.ok) throw new Error('POW challenge failed: HTTP ' + resp.status);
  const data = await resp.json();
  const bizData = (data && data.data && data.data.biz_data) || (data && data.biz_data);
  if (!bizData || !bizData.challenge) throw new Error('No POW challenge');
  return bizData.challenge;
}

// ====== 聊天代理 ======
async function handleChatCompletion(body, env) {
  const session = await getOrCreateSession(env);
  const challenge = await getPowChallenge(env);
  const powAnswer = solvePow(challenge);
  const powHeader = encodePowAnswer(powAnswer);
  const token = await getAccessToken(env);
  const prompt = messagesToPrompt(body.messages);
  const modelType = mapModelType(body.model);
  const thinkingEnabled = shouldEnableThinking(body.model, body.thinking, body.reasoning_effort);

  const resp = await fetch(DEEPSEEK_API_BASE + '/v0/chat/completion', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': 'Bearer ' + token, 'X-Ds-Pow-Response': powHeader },
    body: JSON.stringify({
      chat_session_id: session.sessionId, parent_message_id: null, model_type: modelType,
      prompt, ref_file_ids: [], thinking_enabled: thinkingEnabled,
      search_enabled: body.web_search || false, preempt: false,
    }),
  });
  if (!resp.ok) throw new Error('Chat failed: HTTP ' + resp.status + ' - ' + await resp.text());

  const text = await resp.text();
  const contents = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { const d = JSON.parse(line.slice(6)); if (d.type === 'text' && d.content) contents.push(d.content); } catch (e) {}
    }
  }
  return jsonResponse({
    id: 'chatcmpl-' + uuidv4(), object: 'chat.completion', created: now(), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: contents.join('') }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function handleStreamCompletion(body, env) {
  const session = await getOrCreateSession(env);
  const challenge = await getPowChallenge(env);
  const powAnswer = solvePow(challenge);
  const powHeader = encodePowAnswer(powAnswer);
  const token = await getAccessToken(env);
  const prompt = messagesToPrompt(body.messages);
  const modelType = mapModelType(body.model);
  const thinkingEnabled = shouldEnableThinking(body.model, body.thinking, body.reasoning_effort);

  const resp = await fetch(DEEPSEEK_API_BASE + '/v0/chat/completion', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Authorization': 'Bearer ' + token, 'X-Ds-Pow-Response': powHeader },
    body: JSON.stringify({
      chat_session_id: session.sessionId, parent_message_id: null, model_type: modelType,
      prompt, ref_file_ids: [], thinking_enabled: thinkingEnabled,
      search_enabled: body.web_search || false, preempt: false,
    }),
  });
  if (!resp.ok) throw new Error('Chat failed: HTTP ' + resp.status + ' - ' + await resp.text());
  if (!resp.body) throw new Error('No response body');

  const chatId = 'chatcmpl-' + uuidv4();
  const model = body.model;
  let buffer = '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = resp.body.getReader();
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
                const delta = {};
                if (d.type === 'text') delta.content = d.content;
                else delta.reasoning_content = d.content;
                const chunk = { id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta, finish_reason: null }] };
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
              }
            } catch (e) {}
          }
        }
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: e.message } }) + '\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
        try { reader.releaseLock(); } catch (e) {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no',
    },
  });
}

// ====== HTML 页面 ======
function serveHomePage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DeepSeek Cloudflare Worker API</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{max-width:720px;width:100%;background:#1e293b;border-radius:16px;padding:40px;box-shadow:0 25px 50px rgba(0,0,0,.3)}h1{font-size:28px;margin-bottom:8px;color:#38bdf8}.subtitle{color:#94a3b8;margin-bottom:32px;font-size:14px}.section{margin-bottom:28px}.section h2{font-size:18px;color:#f1f5f9;margin-bottom:12px;border-bottom:1px solid #334155;padding-bottom:8px}.endpoint{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:12px}.method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-right:8px}.post{background:#166534;color:#4ade80}.get{background:#1e3a5f;color:#60a5fa}.path{font-family:Menlo,Consolas,monospace;color:#e2e8f0;font-size:14px}.desc{color:#94a3b8;font-size:13px;margin-top:6px}pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.6;color:#e2e8f0}.comment{color:#64748b}.key{color:#93c5fd}.str{color:#86efac}.models{display:flex;flex-wrap:wrap;gap:8px}.model-tag{background:#334155;color:#e2e8f0;padding:4px 12px;border-radius:20px;font-size:13px}.status{display:flex;align-items:center;gap:8px;margin-top:24px;color:#4ade80;font-size:14px}.dot{width:8px;height:8px;background:#4ade80;border-radius:50%;animation:pulse 2s infinite}@keyframes pulse{0%,to{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div class="container">
<h1>DeepSeek Cloudflare Worker</h1>
<p class="subtitle">OpenAI 兼容的 DeepSeek Web Chat API 代理</p>
<div class="section">
<h2>接口列表</h2>
<div class="endpoint"><span class="method post">POST</span><span class="path">/v1/chat/completions</span><p class="desc">OpenAI 兼容的聊天完成，支持流式和非流式</p></div>
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
response = client.chat.completions.create(model=<span class="str">"deepseek-v4-flash"</span>, messages=[{<span class="str">"role"</span>:<span class="str">"user"</span>,<span class="str">"content"</span>:<span class="str">"Hello"</span>}])</pre>
</div>
<div class="status"><div class="dot"></div><span>服务运行中</span></div>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function serveTokenPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>获取 DeepSeek userToken</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column}.top-bar{background:#1e293b;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #334155;flex-shrink:0}.top-bar h1{font-size:16px;color:#38bdf8;white-space:nowrap}.top-bar .status{font-size:12px;color:#94a3b8;margin-left:auto}.top-bar .status.found{color:#4ade80}.iframe-wrap{flex:1;position:relative;background:#000}.iframe-wrap iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none}.result-bar{background:#1e293b;padding:14px 16px;border-top:1px solid #334155;flex-shrink:0;display:none}.result-bar.show{display:block}.result-bar .token-row{display:flex;gap:8px;align-items:center}.result-bar input{flex:1;padding:10px 12px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#e2e8f0;font-size:13px;outline:none}.result-bar input:focus{border-color:#2563eb}.result-bar .btn-sm{padding:10px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}.btn-copy{background:#2563eb;color:#fff}.btn-copy.copied{background:#166534;color:#4ade80}.result-bar .email{font-size:12px;color:#94a3b8;margin-top:6px}.result-bar .label{font-size:12px;font-weight:600;margin-bottom:4px}.label.success{color:#4ade80}.label.error{color:#fca5a5}.label.waiting{color:#f59e0b}.manual-section{background:#0f172a;padding:14px 16px;border-top:1px solid #334155;flex-shrink:0}.manual-section .toggle{font-size:12px;color:#94a3b8;text-align:center;padding:6px;cursor:pointer}.manual-section .content{display:none;margin-top:8px}.manual-section .content.show{display:block}.manual-section textarea{width:100%;height:60px;padding:10px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#e2e8f0;font-size:12px;font-family:Menlo,Consolas,monospace;resize:vertical;outline:none}.manual-section textarea:focus{border-color:#2563eb}.manual-section .btn-row{display:flex;gap:8px;margin-top:8px}.manual-section .btn-row button{flex:1;padding:10px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}.btn-verify{background:#2563eb;color:#fff}.btn-paste{background:transparent;border:2px solid #334155;color:#e2e8f0}.howto{background:#1e293b;padding:12px 16px;font-size:11px;color:#94a3b8;line-height:1.6;flex-shrink:0}.howto a{color:#38bdf8}.howto b{color:#fbbf24}.loading-overlay{position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:10}.loading-overlay.hidden{display:none}.spinner{width:40px;height:40px;border:3px solid #334155;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}@keyframes spin{to{transform:rotate(360deg)}}.loading-text{color:#94a3b8;font-size:13px}
</style>
</head>
<body>
<div class="top-bar">
<h1>获取 DeepSeek Token</h1>
<span class="status" id="statusText">加载中...</span>
</div>
<div class="iframe-wrap" id="iframeWrap">
<div class="loading-overlay" id="loadingOverlay">
<div class="spinner"></div>
<div class="loading-text">正在加载 DeepSeek 登录页...</div>
</div>
<iframe id="dsFrame" src="/proxy/" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
</div>
<div class="result-bar" id="resultBar">
<div class="label" id="resultLabel">Token 获取成功</div>
<div class="token-row">
<input type="text" id="tokenInput" placeholder="Token 将自动显示在此处..." readonly>
<button class="btn-sm btn-copy" id="copyBtn" onclick="copyResult()">复制</button>
</div>
<div class="email" id="emailText"></div>
</div>
<div class="manual-section">
<div class="toggle" onclick="toggleManual()">如果自动获取失败，点此手动输入 Token ▼</div>
<div class="content" id="manualContent">
<textarea id="manualToken" placeholder="粘贴 userToken（以 eyJ... 开头）"></textarea>
<div class="btn-row">
<button class="btn-verify" onclick="verifyManual()">验证</button>
<button class="btn-paste" onclick="pasteFromClipboard()">从剪贴板粘贴</button>
</div>
</div>
</div>
<div class="howto">
<b>手机操作说明：</b>在上方页面中登录 DeepSeek（如遇人机验证正常完成即可），登录成功后 Token 会自动出现在下方。如未自动获取，请用手机浏览器打开 <a href="https://chat.deepseek.com" target="_blank">chat.deepseek.com</a> 登录，然后复制 userToken 粘贴到上方输入框。
</div>
<script>
var pollTimer = null;
var pollCount = 0;

// Listen for token from iframe via postMessage (injected by proxy)
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'ds-token' && e.data.token) {
    showToken(e.data.token);
  }
});

// Also poll the proxy for token
function startPolling() {
  pollTimer = setInterval(async function() {
    pollCount++;
    try {
      var resp = await fetch('/proxy/__token__');
      if (resp.ok) {
        var data = await resp.json();
        if (data.token) {
          showToken(data.token);
          stopPolling();
        }
      }
    } catch(e) {}
    // Stop after 5 minutes
    if (pollCount > 300) stopPolling();
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function showToken(token) {
  stopPolling();
  document.getElementById('tokenInput').value = token;
  document.getElementById('resultBar').classList.add('show');
  document.getElementById('resultLabel').className = 'label success';
  document.getElementById('resultLabel').textContent = 'Token 获取成功！';
  document.getElementById('statusText').textContent = '已获取';
  document.getElementById('statusText').className = 'status found';
  // Verify token
  verifyAndShow(token);
}

async function verifyAndShow(token) {
  try {
    var resp = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' }
    });
    if (resp.ok) {
      var data = await resp.json();
      var email = (data && data.data && data.data.biz_data && data.data.biz_data.user && data.data.biz_data.user.email) || '未知';
      document.getElementById('emailText').textContent = '账号：' + email;
      document.getElementById('resultLabel').className = 'label success';
      document.getElementById('resultLabel').textContent = 'Token 有效！';
    } else {
      document.getElementById('resultLabel').className = 'label error';
      document.getElementById('resultLabel').textContent = 'Token 可能无效 (HTTP ' + resp.status + ')';
    }
  } catch(e) {
    document.getElementById('resultLabel').className = 'label error';
    document.getElementById('resultLabel').textContent = '验证失败: ' + e.message;
  }
}

function copyResult() {
  var token = document.getElementById('tokenInput').value;
  if (!token) return;
  navigator.clipboard.writeText(token).then(function() {
    var btn = document.getElementById('copyBtn');
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
  }).catch(function() {
    // Fallback for mobile
    document.getElementById('tokenInput').select();
    document.execCommand('copy');
    var btn = document.getElementById('copyBtn');
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
  });
}

function toggleManual() {
  document.getElementById('manualContent').classList.toggle('show');
}

async function verifyManual() {
  var token = document.getElementById('manualToken').value.trim();
  if (!token) return;
  showToken(token);
}

async function pasteFromClipboard() {
  try {
    var text = await navigator.clipboard.readText();
    document.getElementById('manualToken').value = text;
    verifyManual();
  } catch(e) {
    alert('无法读取剪贴板，请手动粘贴');
  }
}

// Hide loading overlay when iframe loads
document.getElementById('dsFrame').addEventListener('load', function() {
  document.getElementById('loadingOverlay').classList.add('hidden');
  document.getElementById('statusText').textContent = '请在下方页面中登录';
  // Start polling for token
  startPolling();
});

// Also start polling immediately
startPolling();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ====== 反向代理 ======
async function handleProxy(request) {
  const url = new URL(request.url);
  let targetPath = url.pathname.replace(/^\/proxy/, '') || '/';
  // Keep query string
  const targetUrl = 'https://chat.deepseek.com' + targetPath + (url.search || '');
  
  // Special endpoint for token polling
  if (targetPath === '/__token__') {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/(?:^|;\s*)userToken=([^;]+)/);
    const token = match ? match[1] : null;
    return new Response(JSON.stringify({ token }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  
  // Build proxy request
  const proxyHeaders = new Headers();
  const copyHeaders = ['accept', 'accept-language', 'content-type', 'cookie', 'referer', 'user-agent', 'x-client-locale', 'x-client-platform', 'x-client-version', 'x-app-version', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
  for (const h of copyHeaders) {
    const val = request.headers.get(h);
    if (val) proxyHeaders.set(h, val);
  }
  if (!proxyHeaders.has('user-agent')) proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  proxyHeaders.set('Origin', 'https://chat.deepseek.com');
  proxyHeaders.set('Referer', 'https://chat.deepseek.com/');
  
  const proxyReq = new Request(targetUrl, {
    method: request.method,
    headers: proxyHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  
  const resp = await fetch(proxyReq);
  
  // Handle redirects
  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const loc = resp.headers.get('Location') || '';
    let newLoc = loc;
    if (loc.startsWith('https://chat.deepseek.com')) {
      newLoc = '/proxy' + loc.slice('https://chat.deepseek.com'.length);
    } else if (loc.startsWith('/')) {
      newLoc = '/proxy' + loc;
    }
    return new Response(null, {
      status: 302,
      headers: { 'Location': newLoc, 'Access-Control-Allow-Origin': '*' }
    });
  }
  
  // Build response headers
  const respHeaders = new Headers();
  const copyRespHeaders = ['content-type', 'content-encoding', 'content-length', 'set-cookie', 'cache-control', 'etag', 'last-modified', 'x-frame-options', 'content-security-policy'];
  for (const h of copyRespHeaders) {
    const val = resp.headers.get(h);
    if (val) {
      if (h === 'set-cookie') {
        // Set cookie on proxy domain
        let cookie = val;
        // Remove domain restriction
        cookie = cookie.replace(/;\s*domain=[^;]+/gi, '');
        cookie = cookie.replace(/;\s*secure/gi, '');
        respHeaders.append('Set-Cookie', cookie);
      } else if (h === 'x-frame-options' || h === 'content-security-policy') {
        // Don't forward frame-blocking headers
      } else {
        respHeaders.set(h, val);
      }
    }
  }
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Credentials', 'true');
  
  // Modify HTML content
  const contentType = resp.headers.get('Content-Type') || '';
  let body = await resp.arrayBuffer();
  
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    let html = new TextDecoder().decode(body);
    
    // Replace absolute URLs pointing to deepseek
    html = html.replace(/https:\/\/chat\.deepseek\.com/g, '/proxy');
    html = html.replace(/"\/_next\//g, '"/proxy/_next/');
    html = html.replace(/"\/api\//g, '"/proxy/api/');
    html = html.replace(/"\/v0\//g, '"/proxy/v0/');
    html = html.replace(/"\/auth\//g, '"/proxy/auth/');
    html = html.replace(/"\/login/g, '"/proxy/login');
    html = html.replace(/"\/signup/g, '"/proxy/signup');
    html = html.replace(/'\/_next\//g, "'/proxy/_next/");
    html = html.replace(/'\/api\//g, "'/proxy/api/");
    html = html.replace(/'\/v0\//g, "'/proxy/v0/");
    html = html.replace(/'\/auth\//g, "'/proxy/auth/");
    // Fix relative paths in src/href that start with /
    html = html.replace(/(src|href)="\/(?![\/])/g, '$1="/proxy/');
    html = html.replace(/(src|href)='\/(?![\/])/g, "$1='/proxy/");
    
    // Inject token extraction script before </body>
    const injectScript = '<script>setInterval(function(){try{var t=localStorage.getItem("userToken");if(t&&t!==window.__sentToken){window.__sentToken=t;window.parent.postMessage({type:"ds-token",token:t},"*")}}catch(e){}},1500);</script>';
    html = html.replace('</body>', injectScript + '</body>');
    if (!html.includes('</body>')) html += injectScript;
    
    body = new TextEncoder().encode(html);
    respHeaders.set('Content-Length', String(body.length));
  }
  
  return new Response(body, { status: resp.status, headers: respHeaders });
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
  async fetch(request, env) {
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
      if (path.startsWith('/proxy/')) return handleProxy(request);

      if (path === '/v1/chat/completions') {
        if (request.method !== 'POST') return jsonResponse({ error: { message: 'Method not allowed', type: 'invalid_request_error' } }, 405);

        let body;
        try { body = await request.json(); } catch (e) {
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
    } catch (e) {
      return jsonResponse({ error: { message: e.message || 'Internal error', type: 'server_error' } }, 500);
    }
  },
};