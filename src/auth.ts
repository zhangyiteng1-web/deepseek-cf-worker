/**
 * 认证模块
 *
 * 管理 DeepSeek 的 Token 生命周期：
 * 1. userToken（长期有效）-> 存储在环境变量中
 * 2. accessToken（1 小时有效）-> 内存缓存，自动刷新
 */

import type { WorkerEnv, TokenCache } from './types';
import { DEEPSEEK_API_BASE, DEFAULT_HEADERS, now, pickToken } from './utils';

/** 全局 accessToken 缓存（Worker 实例级别） */
let tokenCache: TokenCache | null = null;

/**
 * 获取有效的 accessToken
 * 优先从缓存读取，过期则自动刷新
 */
export async function getAccessToken(env: WorkerEnv): Promise<string> {
  // 检查缓存是否有效（提前 5 分钟刷新）
  if (tokenCache && tokenCache.expiresAt > now() + 300) {
    return tokenCache.accessToken;
  }

  return refreshAccessToken(env);
}

/**
 * 刷新 accessToken
 */
export async function refreshAccessToken(env: WorkerEnv): Promise<string> {
  const userToken = getUserToken(env);

  console.log('[Auth] Refreshing accessToken...');

  const response = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
    method: 'GET',
    headers: {
      ...DEFAULT_HEADERS,
      'Authorization': `Bearer ${userToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to refresh token: HTTP ${response.status} - ${text}`);
  }

  const data = await response.json() as any;
  const bizData = data?.data?.biz_data || data?.biz_data;

  if (!bizData?.token) {
    throw new Error(`Token refresh failed: ${data?.msg || 'unknown error'}`);
  }

  tokenCache = {
    accessToken: bizData.token,
    expiresAt: now() + 3600, // 1 小时有效期
  };

  console.log('[Auth] accessToken refreshed successfully');
  return tokenCache.accessToken;
}

/**
 * 获取 userToken
 * 支持多 token 负载均衡
 */
function getUserToken(env: WorkerEnv): string {
  // 优先使用多 token 配置
  if (env.DEEPSEEK_USER_TOKENS) {
    return pickToken(env.DEEPSEEK_USER_TOKENS);
  }

  // 单个 token
  if (env.DEEPSEEK_USER_TOKEN) {
    return env.DEEPSEEK_USER_TOKEN.trim();
  }

  throw new Error(
    '未配置 DeepSeek Token。请设置环境变量 DEEPSEEK_USER_TOKEN。\n' +
    '获取方式：浏览器打开 https://chat.deepseek.com 并登录，\n' +
    'F12 > Application > Local Storage > 复制 userToken 的值。\n' +
    '然后运行：wrangler secret put DEEPSEEK_USER_TOKEN'
  );
}

/**
 * 检测 userToken 是否有效
 */
export async function checkTokenValid(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 使用账号密码登录获取 userToken（不推荐，可能触发验证码）
 */
export async function loginWithPassword(email: string, password: string): Promise<string> {
  console.log(`[Auth] Attempting login for: ${email}`);

  const response = await fetch(`${DEEPSEEK_API_BASE}/v0/users/login`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Referer': 'https://chat.deepseek.com/sign_in',
      'X-Client-TimeZone-Offset': '28800',
    },
    body: JSON.stringify({
      email,
      password,
      mobile: '',
      area_code: '',
      device_id: '',
      os: 'web',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login failed: HTTP ${response.status} - ${text}`);
  }

  const data = await response.json() as any;

  if (data.code !== 0) {
    throw new Error(`Login failed: ${data.msg || data.data?.biz_msg || 'unknown error'}`);
  }

  const token = data?.data?.biz_data?.user?.token;
  if (!token) {
    throw new Error('Login succeeded but no token received');
  }

  console.log('[Auth] Login successful');
  return token;
}