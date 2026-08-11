/**
 * 聊天代理模块
 *
 * 负责：
 * 1. 创建聊天会话
 * 2. 获取 POW 挑战并求解
 * 3. 发送聊天完成请求（流式 / 非流式）
 * 4. 将 DeepSeek 内部响应转换为 OpenAI 兼容格式
 */

import type {
  WorkerEnv,
  PowChallenge,
  DeepSeekChatRequest,
  OpenAIChatRequest,
  OpenAIChatResponse,
  ChatSession,
  OpenAIMessage,
} from './types';
import { getAccessToken } from './auth';
import { solvePow, encodePowAnswer } from './pow';
import {
  DEEPSEEK_API_BASE,
  DEFAULT_HEADERS,
  uuidv4,
  now,
  messagesToPrompt,
  mapModelType,
  shouldEnableThinking,
} from './utils';

/** 会话缓存 */
const sessionCache = new Map<string, ChatSession>();

/**
 * 创建聊天会话
 */
async function createSession(env: WorkerEnv): Promise<ChatSession> {
  const token = await getAccessToken(env);

  const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ character_id: null }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: HTTP ${response.status}`);
  }

  const data = await response.json() as any;
  const bizData = data?.data?.biz_data || data?.biz_data;
  const sessionId = bizData?.chat_session?.id || bizData?.id;

  if (!sessionId) {
    throw new Error(`Failed to create session: no session ID in response`);
  }

  const session: ChatSession = {
    id: sessionId,
    created_at: now(),
  };

  sessionCache.set(sessionId, session);
  console.log(`[Session] Created: ${sessionId}`);

  return session;
}

/**
 * 获取或创建会话
 */
async function getOrCreateSession(env: WorkerEnv): Promise<ChatSession> {
  // 查找有效会话（5 分钟内）
  for (const [, session] of sessionCache) {
    if (now() - session.created_at < 300) {
      return session;
    }
  }
  return createSession(env);
}

/**
 * 获取 POW 挑战
 */
async function getPowChallenge(env: WorkerEnv): Promise<PowChallenge> {
  const token = await getAccessToken(env);

  const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get POW challenge: HTTP ${response.status}`);
  }

  const data = await response.json() as any;
  const bizData = data?.data?.biz_data || data?.biz_data;

  if (!bizData?.challenge) {
    throw new Error(`No POW challenge in response: ${JSON.stringify(data)}`);
  }

  return bizData.challenge as PowChallenge;
}

/**
 * 构建 DeepSeek 内部聊天请求
 */
function buildChatRequest(
  request: OpenAIChatRequest,
  sessionId: string,
  parentMessageId: string | null
): DeepSeekChatRequest {
  const prompt = messagesToPrompt(request.messages);
  const modelType = mapModelType(request.model);
  const thinkingEnabled = shouldEnableThinking(
    request.model,
    request.thinking,
    request.reasoning_effort
  );

  return {
    chat_session_id: sessionId,
    parent_message_id: parentMessageId,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: request.web_search ?? false,
    preempt: false,
  };
}

/**
 * 处理非流式聊天完成
 */
export async function handleChatCompletion(
  request: OpenAIChatRequest,
  env: WorkerEnv
): Promise<Response> {
  try {
    const session = await getOrCreateSession(env);
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    const powHeader = encodePowAnswer(powAnswer);
    const token = await getAccessToken(env);

    const body = buildChatRequest(request, session.id, null);

    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
        'X-Ds-Pow-Response': powHeader,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat completion failed: HTTP ${response.status} - ${errorText}`);
    }

    // 非流式模式：收集所有 SSE 事件并合并
    const text = await response.text();
    const content = parseSSEResponse(text);

    const result: OpenAIChatResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: now(),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || 'Internal server error',
          type: 'server_error',
        },
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

/**
 * 处理流式聊天完成
 */
export async function handleStreamCompletion(
  request: OpenAIChatRequest,
  env: WorkerEnv
): Promise<Response> {
  try {
    const session = await getOrCreateSession(env);
    const challenge = await getPowChallenge(env);
    const powAnswer = solvePow(challenge);
    const powHeader = encodePowAnswer(powAnswer);
    const token = await getAccessToken(env);

    const body = buildChatRequest(request, session.id, null);

    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
        'X-Ds-Pow-Response': powHeader,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat completion failed: HTTP ${response.status} - ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    // 转换 SSE 流为 OpenAI 格式
    const stream = transformSSEStream(response.body, request.model);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || 'Internal server error',
          type: 'server_error',
        },
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

/**
 * 解析 SSE 响应文本，提取完整内容
 */
function parseSSEResponse(text: string): string {
  const lines = text.split('\n');
  const contents: string[] = [];

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'text' && data.content) {
          contents.push(data.content);
        } else if (data.type === 'thinking' && data.content) {
          // 思考内容可选包含
          contents.push(`[思考] ${data.content}`);
        }
      } catch {
        // 跳过无法解析的行
      }
    }
  }

  return contents.join('');
}

/**
 * 将 DeepSeek SSE 流转换为 OpenAI 兼容格式
 */
function transformSSEStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream {
  const chatId = `chatcmpl-${uuidv4()}`;
  let buffer = '';
  let hasContent = false;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readable = new ReadableStream({
    async start(controller) {
      const reader = body.getReader();

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
              const data = JSON.parse(line.slice(6));

              // 处理文本内容
              if (data.type === 'text' && data.content) {
                hasContent = true;
                const chunk = {
                  id: chatId,
                  object: 'chat.completion.chunk',
                  created: now(),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: data.content },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }

              // 处理思考内容（输出到 reasoning_content）
              if (data.type === 'thinking' && data.content) {
                hasContent = true;
                const chunk = {
                  id: chatId,
                  object: 'chat.completion.chunk',
                  created: now(),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: data.content },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }

              // 处理联网搜索
              if (data.type === 'search' && data.content) {
                hasContent = true;
                const chunk = {
                  id: chatId,
                  object: 'chat.completion.chunk',
                  created: now(),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: `\n[搜索] ${data.content}\n` },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
            } catch {
              // 跳过非 JSON 行
            }
          }
        }

        // 发送结束信号
        const finishChunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created: now(),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`)
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error: any) {
        const errorChunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created: now(),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'error',
            },
          ],
          error: { message: error.message },
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });

  return readable;
}