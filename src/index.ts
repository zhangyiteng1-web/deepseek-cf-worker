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