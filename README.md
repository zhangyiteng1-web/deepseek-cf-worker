# DeepSeek Cloudflare Worker API

> 将 DeepSeek Web Chat 转换为 OpenAI 兼容 API，部署在 Cloudflare Workers 上，只需提供 DeepSeek 账号的 userToken 即可无限使用。

## 原理

DeepSeek 网页版 (chat.deepseek.com) 使用 JWT Token 认证，通过浏览器 LocalStorage 中的 `userToken` 即可调用其内部 API。本项目将这套内部 API 封装为 OpenAI 兼容格式，部署在 Cloudflare 边缘网络，实现：

- **零成本部署**：Cloudflare Workers 免费额度每天 10 万次请求
- **全球低延迟**：运行在 Cloudflare 全球边缘节点
- **OpenAI 兼容**：可直接替换任何 OpenAI SDK 的 base_url
- **无 token 限制**：使用 Web 端 API，不受官方 API 的 token 配额限制

## 快速开始

### 1. 获取 DeepSeek userToken

1. 打开 https://chat.deepseek.com 并登录你的账号
2. 按 `F12` 打开开发者工具
3. 进入 **Application** → **Local Storage** → `https://chat.deepseek.com`
4. 复制 `userToken` 的值（以 `eyJ...` 开头的一长串字符）

> **提示**：可以配置多个账号的 token（用逗号分隔），实现负载均衡和并发提升。

### 2. 安装依赖

```bash
cd deepseek-cf-worker
npm install
```

### 3. 配置 Token

```bash
# 设置 userToken（必填）
npx wrangler secret put DEEPSEEK_USER_TOKEN

# 可选：设置 API Key 保护你的接口不被他人滥用
npx wrangler secret put API_KEY
```

> 多账号支持：设置 `DEEPSEEK_USER_TOKENS` 并用逗号分隔多个 token：
> ```bash
> npx wrangler secret put DEEPSEEK_USER_TOKENS
> # 输入: token1,token2,token3
> ```

### 4. 本地测试

```bash
npm run dev
```

### 5. 部署到 Cloudflare

```bash
npm run deploy
```

部署成功后，你会得到一个 `https://xxx.workers.dev` 的域名。可以在 Cloudflare Dashboard 中绑定自定义域名。

### 6. 测试

```bash
curl https://your-domain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "你好，请介绍一下自己"}]
  }'
```

## API 文档

### POST /v1/chat/completions

OpenAI 兼容的聊天完成接口。

**请求头：**

| 参数 | 说明 |
|------|------|
| Content-Type | application/json |
| Authorization | Bearer {API_KEY}（如果配置了 API_KEY） |

**请求体：**

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "stream": false,
  "temperature": 0.7,
  "web_search": false,
  "thinking": {"type": "enabled"},
  "reasoning_effort": "medium"
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 否 | 模型名称，默认 deepseek-v4-flash |
| messages | array | 是 | 消息列表 |
| stream | boolean | 否 | 是否流式输出，默认 false |
| temperature | float | 否 | 温度参数 |
| web_search | boolean | 否 | 是否启用联网搜索 |
| thinking | object | 否 | 思考模式 `{"type": "enabled"/"disabled"}` |
| reasoning_effort | string | 否 | 推理强度：low / medium / high |

### GET /v1/models

获取可用模型列表。

### GET /health

健康检查。

## 支持模型

| 模型 | 说明 |
|------|------|
| deepseek-v4-flash | 快速响应，默认模型 |
| deepseek-v4-flash-think | Flash + 深度思考 |
| deepseek-v4-flash-fast | Flash 快速模式（无思考） |
| deepseek-v4-pro | 专业版，默认开启思考 |
| deepseek-v4-pro-think | Pro + 深度思考 |
| deepseek-v4-pro-fast | Pro 快速模式（无思考） |
| deepseek-r1 | R1 推理模型 |
| deepseek-chat | 通用对话 |
| deepseek-reasoner | 推理模型 |

## 客户端接入示例

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-domain.workers.dev/v1",
    api_key="any-value"  # 如果配置了 API_KEY，则填实际值
)

# 非流式
response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "用 Python 写一个快速排序"}]
)
print(response.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "解释量子计算"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Node.js

```javascript
const response = await fetch("https://your-domain.workers.dev/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Hello" }]
  })
});
const data = await response.json();
console.log(data.choices[0].message.content);
```

### 接入 ChatBox / NextChat / LobeChat 等客户端

在客户端的 API 设置中：
- **API 地址**：`https://your-domain.workers.dev/v1`
- **API Key**：任意值（或你配置的 API_KEY）
- **模型**：选择上面列表中任意一个

## 架构说明

```
用户请求
    │
    ▼
Cloudflare Worker (边缘节点)
    │
    ├─ 1. API Key 验证（可选）
    ├─ 2. 获取/刷新 accessToken（缓存 1 小时）
    ├─ 3. 创建聊天会话
    ├─ 4. 获取 POW 挑战并求解
    ├─ 5. 转发请求到 chat.deepseek.com
    └─ 6. 转换响应为 OpenAI 格式
        │
        ▼
    chat.deepseek.com (DeepSeek 服务器)
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| DEEPSEEK_USER_TOKEN | 是* | 从浏览器 LocalStorage 获取的 userToken |
| DEEPSEEK_USER_TOKENS | 否 | 多个 token，逗号分隔（负载均衡） |
| API_KEY | 否 | 自定义 API Key，保护接口不被滥用 |
| DEEPSEEK_EMAIL | 否 | 账号邮箱（自动登录，不推荐） |
| DEEPSEEK_PASSWORD | 否 | 账号密码（自动登录，不推荐） |

> *`DEEPSEEK_USER_TOKEN` 和 `DEEPSEEK_USER_TOKENS` 二选一。

## 注意事项

1. **并发限制**：每个 DeepSeek 账号仅支持 1 路并发流式输出。如需更高并发，请配置多个 token。
2. **Token 有效期**：`userToken` 有效期较长（数天至数周），但建议定期更新。
3. **POW 计算**：每次请求需要计算 POW，通常耗时 1-5 秒，在 Cloudflare Worker 的 CPU 时间限制内。
4. **仅供学习研究**：本项目基于 DeepSeek Web Chat 的内部 API 实现，仅供学习研究使用。请遵守 DeepSeek 的服务条款。
5. **不稳定性**：DeepSeek 可能随时更新其 Web 端接口，导致本项目失效。届时请关注更新。

## 项目结构

```
deepseek-cf-worker/
├── src/
│   ├── index.ts      # Worker 主入口，路由分发
│   ├── auth.ts       # 认证模块（Token 管理）
│   ├── proxy.ts      # 聊天代理（会话、POW、请求转发）
│   ├── pow.ts        # POW 求解器（SHA3-512）
│   ├── utils.ts      # 工具函数
│   └── types.ts      # 类型定义
├── wrangler.toml     # Cloudflare Worker 配置
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT