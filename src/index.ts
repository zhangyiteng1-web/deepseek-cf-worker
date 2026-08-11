/**
 * Cloudflare Worker 主入口
 *
 * DeepSeek Web Chat API 代理服务
 *
 * 功能：
 * - POST /v1/chat/completions  — OpenAI 兼容的聊天完成（支持流式/非流式）
 * - GET  /v1/models              — 获取可用模型列表
 * - GET  /health                 — 健康检查
 * - GET  /                       — 服务信息页
 *
 * 部署后访问：https://your-domain.com/v1/chat/completions
 */

import type { WorkerEnv, OpenAIChatRequest, ModelInfo } from './types';
import { handleChatCompletion, handleStreamCompletion } from './proxy';
import { jsonResponse } from './utils';

/** 支持的模型列表 */
const MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-flash', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-flash-think', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-flash-fast', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-pro', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-pro-think', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-v4-pro-fast', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-r1', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-chat', object: 'model', created: 1735680000, owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', created: 1735680000, owned_by: 'deepseek' },
];

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // CORS 预检
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

    // API Key 验证（可选）
    if (env.API_KEY) {
      const auth = request.headers.get('Authorization') || '';
      const providedKey = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      if (providedKey !== env.API_KEY) {
        return jsonResponse(
          { error: { message: 'Invalid API key', type: 'authentication_error' } },
          401
        );
      }
    }

    // 路由分发
    try {
      switch (true) {
        // 健康检查
        case path === '/health':
          return jsonResponse({ status: 'ok', timestamp: Date.now() });

        // 模型列表
        case path === '/v1/models':
          return jsonResponse({ object: 'list', data: MODELS });

        // 聊天完成
        case path === '/v1/chat/completions':
          return handleChatRoute(request, env);

        // 获取 Token 工具页
        case path === '/get-token.html':
          return serveTokenPage();

        // 首页
        case path === '/':
          return serveHomePage();

        default:
          return jsonResponse(
            { error: { message: 'Not found', type: 'not_found_error' } },
            404
          );
      }
    } catch (error: any) {
      return jsonResponse(
        {
          error: {
            message: error.message || 'Internal server error',
            type: 'server_error',
          },
        },
        500
      );
    }
  },
};

/**
 * 处理聊天完成路由
 */
async function handleChatRoute(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(
      { error: { message: 'Method not allowed', type: 'invalid_request_error' } },
      405
    );
  }

  let body: OpenAIChatRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      400
    );
  }

  // 参数校验
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse(
      { error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' } },
      400
    );
  }

  // 设置默认模型
  if (!body.model) {
    body.model = 'deepseek-v4-flash';
  }

  // 流式 / 非流式
  if (body.stream) {
    return handleStreamCompletion(body, env);
  }
  return handleChatCompletion(body, env);
}

/**
 * 服务首页
 */
function serveHomePage(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Cloudflare Worker API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 720px;
      width: 100%;
      background: #1e293b;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 25px 50px rgba(0,0,0,0.3);
    }
    h1 { font-size: 28px; margin-bottom: 8px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
    .section { margin-bottom: 28px; }
    .section h2 { font-size: 18px; color: #f1f5f9; margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    .endpoint {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .method {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-right: 8px;
    }
    .post { background: #166534; color: #4ade80; }
    .get { background: #1e3a5f; color: #60a5fa; }
    .path { font-family: 'Menlo', 'Consolas', monospace; color: #e2e8f0; font-size: 14px; }
    .desc { color: #94a3b8; font-size: 13px; margin-top: 6px; }
    pre {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.6;
      color: #e2e8f0;
    }
    .comment { color: #64748b; }
    .key { color: #93c5fd; }
    .str { color: #86efac; }
    .models { display: flex; flex-wrap: wrap; gap: 8px; }
    .model-tag {
      background: #334155;
      color: #e2e8f0;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
    }
    .status { display: flex; align-items: center; gap: 8px; margin-top: 24px; color: #4ade80; font-size: 14px; }
    .dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 DeepSeek Cloudflare Worker</h1>
    <p class="subtitle">OpenAI 兼容的 DeepSeek Web Chat API 代理 · 部署在 Cloudflare 边缘网络</p>

    <div class="section">
      <h2>接口列表</h2>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span class="path">/v1/chat/completions</span>
        <p class="desc">OpenAI 兼容的聊天完成接口，支持流式（stream）和非流式</p>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path">/v1/models</span>
        <p class="desc">获取可用模型列表</p>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path">/health</span>
        <p class="desc">健康检查</p>
      </div>
    </div>

    <div class="section">
      <h2>支持模型</h2>
      <div class="models">
        <span class="model-tag">deepseek-v4-flash</span>
        <span class="model-tag">deepseek-v4-pro</span>
        <span class="model-tag">deepseek-r1</span>
        <span class="model-tag">deepseek-chat</span>
        <span class="model-tag">deepseek-reasoner</span>
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
client = OpenAI(
    base_url=<span class="str">"https://your-domain/v1"</span>,
    api_key=<span class="str">"any-value"</span>
)
response = client.chat.completions.create(
    model=<span class="str">"deepseek-v4-flash"</span>,
    messages=[{<span class="str">"role"</span>: <span class="str">"user"</span>, <span class="str">"content"</span>: <span class="str">"Hello"</span>}]
)</pre>
    </div>

    <div class="status">
      <div class="dot"></div>
      <span>服务运行中 · Cloudflare Edge Network</span>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Token 获取工具页
 */
function serveTokenPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>获取 DeepSeek userToken</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: #1e293b;
      border-radius: 16px;
      padding: 32px 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.3);
    }
    h1 { font-size: 22px; color: #38bdf8; margin-bottom: 6px; text-align: center; }
    .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 28px; text-align: center; }
    .step {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .step-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px; height: 26px;
      background: #2563eb;
      color: #fff;
      border-radius: 50%;
      font-size: 13px;
      font-weight: 700;
      margin-right: 8px;
      flex-shrink: 0;
    }
    .step-title { font-size: 15px; font-weight: 600; color: #f1f5f9; margin-bottom: 8px; }
    .step p { color: #94a3b8; font-size: 13px; line-height: 1.6; }
    .code-block {
      background: #0f172a;
      border: 1px solid #475569;
      border-radius: 8px;
      padding: 14px;
      margin: 12px 0;
      font-family: 'Menlo', 'Consolas', monospace;
      font-size: 12px;
      color: #86efac;
      word-break: break-all;
      line-height: 1.5;
      max-height: 120px;
      overflow-y: auto;
      position: relative;
    }
    .copy-btn {
      position: absolute;
      top: 8px; right: 8px;
      background: #334155;
      color: #e2e8f0;
      border: none;
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .copy-btn:active { background: #2563eb; }
    .copy-btn.copied { background: #166534; color: #4ade80; }
    .btn {
      display: block;
      width: 100%;
      padding: 14px;
      margin: 8px 0;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #2563eb;
      color: #fff;
    }
    .btn-primary:active { background: #1d4ed8; }
    .btn-outline {
      background: transparent;
      border: 2px solid #334155;
      color: #e2e8f0;
    }
    .btn-outline:active { border-color: #2563eb; }
    .result-box {
      background: #0f172a;
      border: 2px solid #4ade80;
      border-radius: 10px;
      padding: 16px;
      margin-top: 16px;
      display: none;
    }
    .result-box.show { display: block; }
    .result-box .label { color: #4ade80; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .result-box .token {
      font-family: 'Menlo', 'Consolas', monospace;
      font-size: 12px;
      color: #86efac;
      word-break: break-all;
      line-height: 1.5;
    }
    .tip {
      background: #1e293b;
      border-left: 3px solid #f59e0b;
      border-radius: 6px;
      padding: 12px;
      margin-top: 20px;
      font-size: 12px;
      color: #fcd34d;
      line-height: 1.6;
    }
    hr { border: none; border-top: 1px solid #334155; margin: 24px 0; }
    .warning {
      background: #450a0a;
      border: 1px solid #dc2626;
      border-radius: 8px;
      padding: 12px;
      margin-top: 16px;
      font-size: 12px;
      color: #fca5a5;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>获取 DeepSeek userToken</h1>
    <p class="subtitle">用于 Cloudflare Worker API 代理</p>

    <div class="step">
      <span class="step-num">1</span>
      <span class="step-title">电脑端（推荐）</span>
      <p>用电脑浏览器打开 <a href="https://chat.deepseek.com" style="color:#38bdf8;" target="_blank">chat.deepseek.com</a> 并登录，然后按 <b>F12</b> → <b>Application</b> → <b>Local Storage</b> → <b>chat.deepseek.com</b> → 复制 <b>userToken</b> 的值。</p>
    </div>

    <div class="step">
      <span class="step-num">2</span>
      <span class="step-title">手机端：书签脚本法</span>
      <p>在手机浏览器中操作：</p>
      <p style="margin-top:8px;">① 先打开 <b>chat.deepseek.com</b> 并登录</p>
      <p>② 将下方代码<b>添加为书签</b>，然后在 chat.deepseek.com 页面<b>点击该书签</b>即可弹出 Token</p>
      <div class="code-block" style="position:relative;">
        <button class="copy-btn" id="copyScriptBtn" onclick="copyScript()">复制</button>
        <code id="scriptCode">(function(){var t=localStorage.getItem('userToken');if(t){var e=document.createElement('div');e.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';var n=document.createElement('div');n.style.cssText='background:#1e293b;border-radius:16px;padding:24px;width:100%;max-width:500px;text-align:center;';n.innerHTML='<h2 style="color:#4ade80;margin-bottom:12px;">Token 获取成功</h2><div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:16px;word-break:break-all;font-size:12px;color:#86efac;text-align:left;max-height:200px;overflow-y:auto;" id="ds-token">'+t+'</div><button style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;margin:4px;cursor:pointer;" onclick="navigator.clipboard.writeText(this.parentElement.querySelector(\\'#ds-token\\').textContent).then(function(){this.textContent=\\'已复制\\';this.style.background=\\'#166534\\'}.bind(this))">复制 Token</button>';e.appendChild(n);document.body.appendChild(e)}else{alert('未找到 userToken，请确认已登录 chat.deepseek.com')}})();</code>
      </div>
      <p style="font-size:11px; color:#64748b; margin-top:4px;"><b>如何添加书签：</b>浏览器菜单 → 添加书签 → 名称随意，网址粘贴上面代码 → 保存。然后在 chat.deepseek.com 页面打开书签。</p>
    </div>

    <div class="step">
      <span class="step-num">3</span>
      <span class="step-title">已获取到 Token？在这里验证</span>
      <p>将你的 token 粘贴到下方，点击验证：</p>
      <textarea id="tokenInput" placeholder="粘贴你的 userToken（以 eyJ... 开头）" style="width:100%;height:80px;background:#0f172a;border:1px solid #475569;border-radius:8px;padding:12px;color:#e2e8f0;font-size:12px;margin-top:8px;resize:vertical;font-family:Menlo,Consolas,monospace;"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary" onclick="verifyToken()" style="flex:1;">验证 Token</button>
        <button class="btn btn-outline" onclick="copyToken()" style="flex:1;">复制 Token</button>
      </div>
      <div id="verifyResult" class="result-box"></div>
    </div>

    <div class="tip">
      <b>提示：</b>userToken 是以 <b>eyJhbGciOiJIUzUxMiIs...</b> 开头的长字符串。如果获取到的不是这个格式，说明可能取错了。
    </div>

    <div class="warning">
      <b>安全提醒：</b>Token 相当于你的账号密码，<b>不要分享给任何人</b>。在 Cloudflare 配置时使用 <b>wrangler secret</b> 加密存储，不要直接写在代码里。
    </div>
  </div>

  <script>
    function copyScript() {
      var code = document.getElementById('scriptCode').textContent;
      navigator.clipboard.writeText(code).then(function() {
        var btn = document.getElementById('copyScriptBtn');
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
      }).catch(function() {
        alert('复制失败，请手动长按选择复制');
      });
    }

    function copyToken() {
      var token = document.getElementById('tokenInput').value.trim();
      if (!token) { alert('请先粘贴 token'); return; }
      navigator.clipboard.writeText(token).then(function() {
        alert('Token 已复制到剪贴板');
      }).catch(function() {
        alert('复制失败，请手动选择复制');
      });
    }

    async function verifyToken() {
      var token = document.getElementById('tokenInput').value.trim();
      var resultBox = document.getElementById('verifyResult');

      if (!token) {
        resultBox.className = 'result-box show';
        resultBox.innerHTML = '<div class="label">请输入 token</div>';
        return;
      }

      resultBox.className = 'result-box show';
      resultBox.innerHTML = '<div class="label">正在验证...</div>';

      try {
        var resp = await fetch('https://chat.deepseek.com/api/v0/users/current', {
          headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        });

        if (resp.ok) {
          var data = await resp.json();
          var email = (data && data.data && data.data.biz_data && data.data.biz_data.user && data.data.biz_data.user.email) || (data && data.biz_data && data.biz_data.user && data.biz_data.user.email) || '未知';
          resultBox.innerHTML = '<div class="label">Token 有效！</div>' +
            '<div class="token" style="margin-bottom:8px;">账号：' + email + '</div>' +
            '<div class="token" style="font-size:11px;color:#94a3b8;">现在可以将此 token 配置到 Cloudflare Worker 的环境变量中</div>';
        } else {
          resultBox.innerHTML = '<div class="label">Token 无效</div>' +
            '<div class="token" style="color:#fca5a5;">HTTP ' + resp.status + ' — 请确认 token 正确且未过期</div>';
        }
      } catch (e) {
        resultBox.innerHTML = '<div class="label">网络错误</div>' +
          '<div class="token" style="color:#fca5a5;">无法连接到 DeepSeek，请检查网络</div>';
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}