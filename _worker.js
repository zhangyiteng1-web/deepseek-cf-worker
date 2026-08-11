// ====== SHA3-512 (Keccak) 内联实现 ======
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const RHOS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const ROTL = (v, n) => ((v << n) | (v >> (64n - n))) & 0xFFFFFFFFFFFFFFFFn;

function keccakF(state) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map(x => state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20]);
    const D = [0, 1, 2, 3, 4].map(x => C[(x+4)%5] ^ ROTL(C[(x+1)%5], 1n));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x+5*y] ^= D[x];
    let cur = state[1], cx = 1, cy = 0;
    for (let t = 0; t < 24; t++) {
      const nx = cy, ny = (2*cx + 3*cy) % 5;
      const tmp = state[nx + 5*ny];
      state[nx + 5*ny] = ROTL(cur, BigInt(RHOS[cx + 5*cy]));
      cur = tmp; cx = nx; cy = ny;
    }
    for (let y = 0; y < 5; y++) {
      const T = [0, 1, 2, 3, 4].map(x => state[x+5*y]);
      for (let x = 0; x < 5; x++) state[x+5*y] = T[x] ^ ((~T[(x+1)%5]) & T[(x+2)%5]);
    }
    state[0] ^= RC[r];
  }
}

function sha3_512(msg) {
  const rate = 72, outLen = 64;
  const state = new Array(25).fill(0n);
  let i = 0;
  while (i + rate <= msg.length) {
    for (let j = 0; j < rate; j++) {
      const wi = (j / 8) | 0, bi = j % 8;
      state[wi] ^= BigInt(msg[i + j]) << BigInt(8 * bi);
    }
    keccakF(state);
    i += rate;
  }
  const rem = msg.length - i;
  for (let j = 0; j < rem; j++) {
    const wi = (j / 8) | 0, bi = j % 8;
    state[wi] ^= BigInt(msg[i + j]) << BigInt(8 * bi);
  }
  const wi = (rem / 8) | 0, bi = rem % 8;
  state[wi] ^= 0x06n << BigInt(8 * bi);
  state[(rate - 1) / 8 | 0] ^= 0x80n << BigInt(8 * ((rate - 1) % 8));
  keccakF(state);
  const out = new Uint8Array(outLen);
  let o = 0;
  while (o < outLen) {
    const bs = Math.min(rate, outLen - o);
    for (let j = 0; j < bs; j++) {
      out[o + j] = Number((state[(j / 8) | 0] >> BigInt(8 * (j % 8))) & 0xFFn);
    }
    o += bs;
    if (o < outLen) keccakF(state);
  }
  return out;
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

// ====== POW 求解器 ======
function countLeadingZeroBits(hashBytes) {
  let count = 0;
  for (let i = 0; i < hashBytes.length; i++) {
    if (hashBytes[i] === 0) { count += 8; continue; }
    let b = hashBytes[i];
    while ((b & 0x80) === 0) { count++; b <<= 1; }
    break;
  }
  return count;
}

function solvePow(challenge) {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge;
  const prefix = salt + '_' + expire_at + '_';
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < 500000; nonce++) {
    const input = prefix + challengeStr + nonce;
    const hashBytes = sha3_512(encoder.encode(input));
    if (countLeadingZeroBits(hashBytes) >= difficulty) {
      return { algorithm, challenge: challengeStr, salt, answer: nonce, signature, target_path: '/api/v0/chat/completion' };
    }
  }
  throw new Error('POW failed: exceeded max iterations');
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
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>获取 DeepSeek userToken</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px}.container{max-width:500px;margin:0 auto;background:#1e293b;border-radius:16px;padding:32px 24px;box-shadow:0 20px 40px rgba(0,0,0,.3)}h1{font-size:22px;color:#38bdf8;margin-bottom:6px;text-align:center}.subtitle{color:#94a3b8;font-size:13px;margin-bottom:28px;text-align:center}.form-group{margin-bottom:16px}.form-group label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px}.form-group input{width:100%;padding:12px 14px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none;transition:border-color .2s}.form-group input:focus{border-color:#2563eb}.btn{display:block;width:100%;padding:14px;margin:8px 0;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;text-align:center;transition:all .2s}.btn-primary{background:#2563eb;color:#fff}.btn-primary:hover{background:#1d4ed8}.btn-primary:disabled{opacity:.5;cursor:not-allowed}.btn-outline{background:transparent;border:2px solid #334155;color:#e2e8f0}.result-box{background:#0f172a;border:2px solid #4ade80;border-radius:10px;padding:16px;margin-top:16px;display:none}.result-box.show{display:block}.result-box.error{border-color:#dc2626}.result-box .label{font-size:13px;font-weight:600;margin-bottom:8px}.result-box .label.success{color:#4ade80}.result-box .label.error{color:#fca5a5}.result-box .token{font-family:Menlo,Consolas,monospace;font-size:12px;color:#86efac;word-break:break-all;line-height:1.5;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px;max-height:120px;overflow-y:auto;margin-bottom:10px}.result-box .email{color:#94a3b8;font-size:12px;margin-bottom:4px}.copy-btn-sm{background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:6px 16px;font-size:12px;cursor:pointer;margin-right:8px}.copy-btn-sm.copied{background:#166534;color:#4ade80}.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-radius:50%;border-top-color:#fff;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}@keyframes spin{to{transform:rotate(360deg)}}.tip{background:#1e293b;border-left:3px solid #f59e0b;border-radius:6px;padding:12px;margin-top:20px;font-size:12px;color:#fcd34d;line-height:1.6}.warning{background:#450a0a;border:1px solid #dc2626;border-radius:8px;padding:12px;margin-top:16px;font-size:12px;color:#fca5a5;line-height:1.6}.divider{display:flex;align-items:center;margin:24px 0;color:#475569;font-size:12px}.divider::before,.divider::after{content:'';flex:1;border-top:1px solid #334155}.divider span{padding:0 12px}.manual-section{display:none}.manual-section.show{display:block}
</style>
</head>
<body>
<div class="container">
<h1>获取 DeepSeek userToken</h1>
<p class="subtitle">输入 DeepSeek 账号密码，自动获取 Token</p>

<div class="form-group">
<label>邮箱</label>
<input type="email" id="emailInput" placeholder="your@email.com" autocomplete="email">
</div>
<div class="form-group">
<label>密码</label>
<input type="password" id="passwordInput" placeholder="DeepSeek 登录密码" autocomplete="current-password">
</div>
<button class="btn btn-primary" id="loginBtn" onclick="doLogin()">获取 Token</button>
<div id="resultBox" class="result-box"></div>

<div class="tip"><b>注意：</b>Token 会直接通过浏览器请求 DeepSeek 官方 API，不会经过本服务器。</div>
<div class="warning"><b>安全提醒：</b>Token 相当于密码，<b>不要分享给任何人</b>。</div>

<div class="divider"><span>其他方式</span></div>
<button class="btn btn-outline" onclick="toggleManual()" id="manualToggle">展开手动获取方式</button>
<div class="manual-section" id="manualSection">
<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:18px;margin-bottom:16px;margin-top:12px">
<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:#2563eb;color:#fff;border-radius:50%;font-size:13px;font-weight:700;margin-right:8px;vertical-align:middle">1</span>
<span style="font-size:15px;font-weight:600;color:#f1f5f9">电脑端</span>
<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-top:8px">打开 <a href="https://chat.deepseek.com" target="_blank" style="color:#38bdf8">chat.deepseek.com</a> 并登录，按 <b>F12</b> → <b>Application</b> → <b>Local Storage</b> → <b>chat.deepseek.com</b> → 复制 <b>userToken</b></p>
</div>
<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:18px;margin-bottom:16px">
<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:#2563eb;color:#fff;border-radius:50%;font-size:13px;font-weight:700;margin-right:8px;vertical-align:middle">2</span>
<span style="font-size:15px;font-weight:600;color:#f1f5f9">手机端书签脚本</span>
<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-top:8px">① 登录 chat.deepseek.com<br>② 添加书签，网址填下方代码<br>③ 在 DeepSeek 页面点击书签</p>
<div style="background:#0f172a;border:1px solid #475569;border-radius:8px;padding:14px;margin:12px 0;font-family:Menlo,Consolas,monospace;font-size:12px;color:#86efac;word-break:break-all;line-height:1.5;max-height:120px;overflow-y:auto;position:relative">
<button style="position:absolute;top:8px;right:8px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer" onclick="copyScript()">复制</button>
<code id="scriptCode">(function(){var t=localStorage.getItem('userToken');if(t){var e=document.createElement('div');e.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';var n=document.createElement('div');n.style.cssText='background:#1e293b;border-radius:16px;padding:24px;width:100%;max-width:500px;text-align:center';n.innerHTML='<h2 style="color:#4ade80;margin-bottom:12px">Token 获取成功</h2><div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:16px;word-break:break-all;font-size:12px;color:#86efac;text-align:left;max-height:200px;overflow-y:auto">'+t+'</div><button style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;margin:4px;cursor:pointer" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(function(){this.textContent=\\'已复制\\';this.style.background=\\'#166534\\'}.bind(this))">复制 Token</button>';e.appendChild(n);document.body.appendChild(e)}else{alert('未找到 userToken')}})();</code>
</div>
</div>
</div>
</div>
<script>
function toggleManual(){var s=document.getElementById('manualSection');var b=document.getElementById('manualToggle');if(s.classList.contains('show')){s.classList.remove('show');b.textContent='展开手动获取方式'}else{s.classList.add('show');b.textContent='收起手动获取方式'}}
function copyScript(){var code=document.getElementById('scriptCode').textContent;navigator.clipboard.writeText(code).then(function(){alert('已复制，请添加到书签')})}
async function doLogin(){var email=document.getElementById('emailInput').value.trim();var password=document.getElementById('passwordInput').value;var btn=document.getElementById('loginBtn');var box=document.getElementById('resultBox');if(!email||!password){box.className='result-box error show';box.innerHTML='<div class="label error">请输入邮箱和密码</div>';return}btn.disabled=true;btn.innerHTML='<span class="spinner"></span>正在登录...';box.className='result-box';box.style.display='none';try{var resp=await fetch('https://chat.deepseek.com/api/v0/users/login',{method:'POST',headers:{'Content-Type':'application/json','Accept':'*/*','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Origin':'https://chat.deepseek.com','Referer':'https://chat.deepseek.com/','X-App-Version':'20241129.1','X-Client-Locale':'zh_CN','X-Client-Platform':'web','X-Client-Version':'1.8.0'},body:JSON.stringify({email:email,mobile:'',password:password,area_code:'',device_id:'',os:'web'})});var data=await resp.json();if(data.code===0&&data.data&&data.data.biz_data&&data.data.biz_data.user&&data.data.biz_data.user.token){var token=data.data.biz_data.user.token;var email2=data.data.biz_data.user.email||email;box.className='result-box show';box.innerHTML='<div class="label success">登录成功</div><div class="email">账号：'+email2+'</div><div class="token">'+token+'</div><button class="copy-btn-sm" onclick="var t=this.previousElementSibling.textContent;navigator.clipboard.writeText(t);this.textContent=\\'已复制\\';this.classList.add(\\'copied\\');var self=this;setTimeout(function(){self.textContent=\\'复制 Token\\';self.classList.remove(\\'copied\\')},2000)">复制 Token</button>'}else{var msg=data.msg||(data.data&&data.data.biz_msg)||'登录失败';box.className='result-box error show';box.innerHTML='<div class="label error">'+msg+'</div>';if(data.code===403){box.innerHTML+='<div class="token" style="color:#fca5a5;margin-top:8px">可能需要验证码，请尝试在浏览器中手动登录</div>'}}}catch(e){box.className='result-box error show';box.innerHTML='<div class="label error">网络错误</div><div class="token" style="color:#fca5a5">'+e.message+'</div>'}btn.disabled=false;btn.textContent='获取 Token'}
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
      if (path === '/api/login') return handleLogin(request);
      if (path === '/get-token.html') return serveTokenPage();
      if (path === '/') return serveHomePage();

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