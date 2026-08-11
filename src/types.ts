/**
 * 类型定义
 */

// ====== DeepSeek 内部 API 类型 ======

/** 登录请求 */
export interface LoginRequest {
  email: string;
  mobile: string;
  password: string;
  area_code: string;
  device_id: string;
  os: string;
}

/** 登录响应 */
export interface LoginResponse {
  code: number;
  msg?: string;
  data: {
    biz_data?: {
      user?: {
        token: string;
      };
    };
    biz_msg?: string;
  };
}

/** POW 挑战 */
export interface PowChallenge {
  algorithm: { name: string; version: number };
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

/** POW 应答 */
export interface PowAnswer {
  algorithm: { name: string; version: number };
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
  target_path: string;
}

/** 聊天会话 */
export interface ChatSession {
  id: string;
  created_at: number;
}

/** 聊天完成请求（内部格式） */
export interface DeepSeekChatRequest {
  chat_session_id: string;
  parent_message_id: string | null;
  model_type: 'default' | 'expert';
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

/** 流式响应块 */
export interface StreamChunk {
  type: 'text' | 'thinking' | 'search' | 'error' | 'finish';
  content?: string;
  error?: string;
}

// ====== OpenAI 兼容 API 类型 ======

/** OpenAI 消息 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** OpenAI 聊天完成请求 */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  web_search?: boolean;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
}

/** OpenAI 聊天完成响应 */
export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 模型信息 */
export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// ====== Worker 环境变量 ======

export interface WorkerEnv {
  // 必填：DeepSeek userToken（从浏览器 LocalStorage 获取）
  DEEPSEEK_USER_TOKEN: string;
  // 可选：多账号 token，用逗号分隔
  DEEPSEEK_USER_TOKENS?: string;
  // 可选：自定义 API Key，用于保护你的 Worker 不被他人滥用
  API_KEY?: string;
  // 可选：账号邮箱（用于自动登录，不推荐）
  DEEPSEEK_EMAIL?: string;
  // 可选：账号密码（用于自动登录，不推荐）
  DEEPSEEK_PASSWORD?: string;
  // 可选：代理地址
  HTTP_PROXY?: string;
}

// ====== Token 缓存 ======

export interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

// ====== 会话缓存 ======

export interface SessionCache {
  sessionId: string;
  createdAt: number;
}