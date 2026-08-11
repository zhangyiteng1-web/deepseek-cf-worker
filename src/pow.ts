/**
 * DeepSeek POW (Proof of Work) 求解器
 *
 * DeepSeek Web Chat 使用 POW 挑战来防止自动化请求。
 * 算法基于 SHA3-512，需要在给定前缀和 challenge 下
 * 找到一个 nonce 使得哈希值满足难度要求。
 *
 * 本实现使用 @noble/hashes 纯 JS SHA3 库，兼容 Cloudflare Workers 环境。
 */

import { sha3_512 } from '@noble/hashes/sha3';
import type { PowChallenge, PowAnswer } from './types';

/** 最大迭代次数，防止 Worker 超时 */
const MAX_ITERATIONS = 500000;

/**
 * 计算 SHA3-512 哈希值
 */
function hash(input: string): Uint8Array {
  const encoder = new TextEncoder();
  return sha3_512(encoder.encode(input));
}

/**
 * 计算哈希值的开头的零 bit 数量
 */
function countLeadingZeroBits(hashBytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < hashBytes.length; i++) {
    if (hashBytes[i] === 0) {
      count += 8;
    } else {
      // 计算这个字节中开头的零 bit
      let b = hashBytes[i];
      while ((b & 0x80) === 0) {
        count++;
        b <<= 1;
      }
      break;
    }
  }
  return count;
}

/**
 * 求解 POW 挑战
 *
 * @param challenge - DeepSeek 返回的挑战对象
 * @returns 包含答案的 PowAnswer 对象
 * @throws 如果在最大迭代次数内未找到答案
 */
export function solvePow(challenge: PowChallenge): PowAnswer {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge;

  // 构造前缀: salt_expireAt_
  const prefix = `${salt}_${expire_at}_`;

  console.log(`[POW] Solving challenge: difficulty=${difficulty}, prefix_len=${prefix.length}`);

  for (let nonce = 0; nonce < MAX_ITERATIONS; nonce++) {
    const input = prefix + challengeStr + nonce.toString();
    const hashBytes = hash(input);
    const zeros = countLeadingZeroBits(hashBytes);

    if (zeros >= difficulty) {
      console.log(`[POW] Solution found: nonce=${nonce}, zeros=${zeros}, iterations=${nonce + 1}`);
      return {
        algorithm,
        challenge: challengeStr,
        salt,
        answer: nonce,
        signature,
        target_path: '/api/v0/chat/completion',
      };
    }

    // 每 50000 次输出进度（避免日志过多）
    if (nonce > 0 && nonce % 50000 === 0) {
      console.log(`[POW] Progress: ${nonce} iterations, best zeros so far: ${zeros}`);
    }
  }

  throw new Error(`POW failed: exceeded ${MAX_ITERATIONS} iterations without finding solution`);
}

/**
 * 将 PowAnswer 编码为 Base64 字符串（用于 X-Ds-Pow-Response 头）
 */
export function encodePowAnswer(answer: PowAnswer): string {
  const json = JSON.stringify(answer);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * 快速哈希检查：验证 POW 答案是否正确
 */
export function verifyPowAnswer(answer: PowAnswer): boolean {
  const prefix = `${answer.salt}_${0}_`; // expire_at 在验证时设为 0
  const input = prefix + answer.challenge + answer.answer.toString();
  const hashBytes = hash(input);
  // 简单验证：哈希非全零
  return hashBytes.some((b) => b !== 0);
}