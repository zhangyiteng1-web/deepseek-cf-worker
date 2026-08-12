// ====== DeepSeekHashV1 = SHA3-256 变体: 23 rounds (skip round 0), SHA3 padding ======
// Optimized: Uint32Array instead of BigInt for maximum V8 JIT speed
// 25 lanes × 2 words (hi/lo) = 50 uint32 values

// RC constants as [hi, lo] pairs for rounds 1..23
const RC_WORDS = new Uint32Array([
  0x00000000,0x00000001, 0x00000000,0x00008082, 0x80000000,0x0000808a, 0x80000000,0x80008000,
  0x00000000,0x0000808b, 0x00000000,0x80000001, 0x80000000,0x80008081, 0x80000000,0x00008009,
  0x00000000,0x0000008a, 0x00000000,0x00000088, 0x00000000,0x80008009, 0x00000000,0x8000000a,
  0x00000000,0x8000808b, 0x80000000,0x0000008b, 0x80000000,0x00008089, 0x80000000,0x00008003,
  0x80000000,0x00008002, 0x80000000,0x00000080, 0x00000000,0x0000800a, 0x80000000,0x8000000a,
  0x80000000,0x80008081, 0x80000000,0x00008080, 0x00000000,0x80000001, 0x80000000,0x80008008
]);

const RH = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const PIL = [10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1];
// Rotations for each step of the walking pattern (source lane's rotation)
const ROT_STEPS = (() => {
  const r = new Uint8Array(24);
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) {
    r[t] = RH[x + 5*y];
    const ny = (2*x + 3*y) % 5;
    x = y; y = ny;
  }
  return r;
})();

// 64-bit ROTL on [hi, lo] pair, returns [hi, lo]
// value = hi*2^32 + lo, rotated left by n bits
function ROTL64(hi, lo, n) {
  if (n === 0) return [hi, lo];
  if (n < 32) {
    const carry = lo >>> (32 - n);     // low bits that go into hi
    const wrap = hi >>> (32 - n);      // high bits that wrap around to bottom
    return [((hi << n) | carry) >>> 0, ((lo << n) | wrap) >>> 0];
  }
  n -= 32;
  if (n === 0) return [lo, hi];       // just swap halves
  const carry = hi >>> (32 - n);
  const wrap = lo >>> (32 - n);
  return [((lo << n) | carry) >>> 0, ((hi << n) | wrap) >>> 0];
}

function keccakF_ds(state) {
  // state is Uint32Array of 50 values (25 lanes × 2 words)
  for (let r = 1; r < 24; r++) {
    // Theta
    const C = new Uint32Array(10); // 5 pairs
    for (let x = 0; x < 5; x++) {
      let chi = 0, clo = 0;
      for (let y = 0; y < 5; y++) {
        const i = (x + 5*y) * 2;
        chi ^= state[i]; clo ^= state[i+1];
      }
      C[x*2] = chi; C[x*2+1] = clo;
    }
    // D[x] = C[x-1] ^ ROTL(C[x+1], 1)
    const D = new Uint32Array(10);
    for (let x = 0; x < 5; x++) {
      const c0 = C[((x+4)%5)*2], c1 = C[((x+4)%5)*2+1];
      const c2 = C[((x+1)%5)*2], c3 = C[((x+1)%5)*2+1];
      const [rh, rl] = ROTL64(c2, c3, 1);
      D[x*2] = c0 ^ rh; D[x*2+1] = c1 ^ rl;
    }
    for (let x = 0; x < 5; x++) {
      const dh = D[x*2], dl = D[x*2+1];
      for (let y = 0; y < 5; y++) {
        const i = (x + 5*y) * 2;
        state[i] ^= dh; state[i+1] ^= dl;
      }
    }

    // Rho + Pi
    const tmp = new Uint32Array(2);
    tmp[0] = state[2]; tmp[1] = state[3]; // lane 1
    let curHi = state[2], curLo = state[3];
    
    for (let t = 0; t < 24; t++) {
      const nx = PIL[t];
      const targetIdx = nx * 2;
      const rot = ROT_STEPS[t];
      const [rh, rl] = ROTL64(curHi, curLo, rot);
      const oldHi = state[targetIdx], oldLo = state[targetIdx+1];
      state[targetIdx] = rh; state[targetIdx+1] = rl;
      curHi = oldHi; curLo = oldLo;
    }

    // Chi
    const B = new Uint32Array(50);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (x + 5*y) * 2;
        const nx = ((x+1)%5 + 5*y) * 2, n2x = ((x+2)%5 + 5*y) * 2;
        B[i] = state[i] ^ ((~state[nx]) & state[n2x]);
        B[i+1] = state[i+1] ^ ((~state[nx+1]) & state[n2x+1]);
      }
    }
    state.set(B);

    // Iota
    const rcHi = RC_WORDS[r*2], rcLo = RC_WORDS[r*2+1];
    state[0] ^= rcHi; state[1] ^= rcLo;
  }
}

function absorb(state, bytes, offset, length, blockStart) {
  blockStart = blockStart || 0;
  for (let j = 0; j < length; j++) {
    const byteVal = bytes[offset + j];
    const pos = blockStart + j;
    const wi = (pos >> 3) * 2, bi = pos & 7;
    if (bi < 4) {
      state[wi+1] ^= byteVal << (bi * 8);
    } else {
      state[wi] ^= byteVal << ((bi - 4) * 8);
    }
  }
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += ((b >> 4) < 10 ? String.fromCharCode(48 + (b >> 4)) : String.fromCharCode(87 + (b >> 4))) +
           ((b & 15) < 10 ? String.fromCharCode(48 + (b & 15)) : String.fromCharCode(87 + (b & 15)));
  }
  return hex;
}

// Extract 32 bytes from state (little-endian)
function squeeze256(state) {
  const out = new Uint8Array(32);
  for (let j = 0; j < 32; j++) {
    const wi = (j >> 3) * 2, bi = j & 7;
    if (bi < 4) {
      out[j] = (state[wi+1] >>> (bi * 8)) & 0xFF;
    } else {
      out[j] = (state[wi] >>> ((bi - 4) * 8)) & 0xFF;
    }
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

// ====== POW 求解器 (DeepSeekHashV1) Uint32 version ======
function solvePow(challenge) {
  const { algorithm, challenge: challengeHex, salt, difficulty, expire_at, signature } = challenge;
  const prefix = salt + '_' + expire_at + '_';
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(prefix);
  const targetHex = challengeHex.toLowerCase();
  const rate = 136;
  
  // Pre-compute state after absorbing full 136-byte blocks of prefix
  const baseState = new Uint32Array(50);
  let pos = 0;
  while (pos + rate <= prefixBytes.length) {
    absorb(baseState, prefixBytes, pos, rate);
    keccakF_ds(baseState);
    pos += rate;
  }
  const rem = prefixBytes.length - pos;
  
  for (let nonce = 0; nonce <= difficulty; nonce++) {
    const state = new Uint32Array(baseState);
    
    // Absorb remaining prefix
    absorb(state, prefixBytes, pos, rem);
    
    // Absorb nonce digits at the correct block position (after prefix)
    const nonceStr = String(nonce);
    const nonceBytes = encoder.encode(nonceStr);
    absorb(state, nonceBytes, 0, nonceBytes.length, rem);
    
    // SHA3 padding on the remaining space in the block
    let p = rem + nonceBytes.length;
    const padHi = (p >> 3) * 2, padLo = padHi + 1, padBi = p & 7;
    if (padBi < 4) {
      state[padLo] ^= 0x06 << (padBi * 8);
    } else {
      state[padHi] ^= 0x06 << ((padBi - 4) * 8);
    }
    // Final 0x80 padding at end of rate block (byte 135)
     const fWi = (135 >> 3) * 2, fBi = 135 & 7;
     if (fBi < 4) state[fWi+1] ^= 0x80 << (fBi * 8);
     else state[fWi] ^= 0x80 << ((fBi - 4) * 8);
    
    keccakF_ds(state);
    
    const hash = squeeze256(state);
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
  const token = await getAccessToken(env);
  
  // Check if client provided a pre-computed POW answer (from body._pow_response)
   let powHeader = body._pow_response || '';
  if (!powHeader) {
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    powHeader = encodePowAnswer(powAnswer);
  }
  
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
  const lines = text.replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { const d = JSON.parse(line.slice(6)); if (d.content) contents.push(d.content); } catch (e) {}
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
  const token = await getAccessToken(env);
  
  // Check if client provided a pre-computed POW answer
  let powHeader = body._pow_response || '';
  if (!powHeader) {
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    powHeader = encodePowAnswer(powAnswer);
  }
  
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
          const lines = buffer.replace(/\r/g, '').split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const d = JSON.parse(line.slice(6));
              if (d.content) {
                const delta = {};
                delta.content = d.content;
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
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px}.container{max-width:800px;margin:0 auto}.card{background:#1e293b;border-radius:12px;padding:24px;margin-bottom:16px}h1{font-size:22px;color:#38bdf8;margin-bottom:4px}.subtitle{color:#94a3b8;font-size:13px;margin-bottom:20px}h2{font-size:16px;color:#f1f5f9;margin-bottom:10px;border-bottom:1px solid #334155;padding-bottom:6px}.endpoint{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:10px}.method{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;min-width:40px;text-align:center}.post{background:#166534;color:#4ade80}.get{background:#1e3a5f;color:#60a5fa}.path{font-family:Menlo,Consolas,monospace;color:#e2e8f0;font-size:13px;flex:1}.desc{color:#94a3b8;font-size:12px;flex:2;text-align:right}pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;overflow-x:auto;font-size:12px;line-height:1.5;color:#e2e8f0}.comment{color:#64748b}.key{color:#93c5fd}.str{color:#86efac}.models{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.model-tag{background:#334155;color:#e2e8f0;padding:4px 10px;border-radius:16px;font-size:12px}.status{display:flex;align-items:center;gap:6px;color:#4ade80;font-size:13px}.dot{width:8px;height:8px;background:#4ade80;border-radius:50%;animation:pulse 2s infinite}@keyframes pulse{0%,to{opacity:1}50%{opacity:.4}}.warn{background:#451a03;border:1px solid #92400e;border-radius:8px;padding:12px 16px;margin-top:12px;font-size:12px;color:#fbbf24;line-height:1.6}.warn b{color:#fcd34d}.copy-btn{background:#334155;color:#e2e8f0;border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:8px}.copy-btn.copied{background:#166534;color:#4ade80}
</style>
</head>
<body>
<div class="container">
<div class="card">
<h1>DeepSeek Cloudflare Worker</h1>
<p class="subtitle">OpenAI 兼容的 DeepSeek Web Chat API 代理 — 已启用自动 POW 求解</p>
<div class="status"><div class="dot"></div><span>服务运行中 · POW 自动处理</span></div>
</div>

<div class="card">
<h2>接口列表</h2>
<div class="endpoint"><span class="method post">POST</span><span class="path">/v1/chat/completions</span><span class="desc">聊天完成（自动处理 POW）</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/v1/models</span><span class="desc">模型列表</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/v1/pow-challenge</span><span class="desc">获取 POW 挑战（高级用法）</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/get-token.html</span><span class="desc">获取 userToken 工具页</span></div>
</div>

<div class="card">
<h2>支持模型</h2>
<div class="models">
<span class="model-tag">deepseek-v4-flash</span><span class="model-tag">deepseek-v4-pro</span><span class="model-tag">deepseek-r1</span><span class="model-tag">deepseek-chat</span><span class="model-tag">deepseek-reasoner</span>
</div>
</div>

<div class="card">
<h2>Trae 配置</h2>
<pre><span class="comment">API 地址：</span><span class="str">https://<span id="domainSpan">your-domain</span>/v1</span>
<span class="comment">API Key：</span><span class="str">sk-any</span>（未设置 API_KEY 时随意填）
<span class="comment">模型：</span>deepseek-v4-flash</pre>
</div>
</div>
<script>
document.getElementById('domainSpan').textContent = location.host;
</script>
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
      if (path === '/v1/pow-challenge') {
         try {
           const challenge = await getPowChallenge(env);
           return jsonResponse(challenge);
         } catch (e) {
           return jsonResponse({ error: e.message }, 500);
         }
       }
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

        // Inject POW answer from header if provided
        const clientPow = request.headers.get('x-ds-pow-response');
        if (clientPow) body._pow_response = clientPow;

        if (body.stream) return handleStreamCompletion(body, env);
        return handleChatCompletion(body, env);
      }

      return jsonResponse({ error: { message: 'Not found', type: 'not_found_error' } }, 404);
    } catch (e) {
      return jsonResponse({ error: { message: e.message || 'Internal error', type: 'server_error' } }, 500);
    }
  },
};