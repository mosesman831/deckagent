import type { Env } from "./types.js";

/**
 * Constant-time string compare that works in both Cloudflare Workers and Node.
 * (Workers expose crypto.subtle.timingSafeEqual; Node's webcrypto often does not.)
 */
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Prefer SubtleCrypto.timingSafeEqual when available (CF Workers).
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean;
  };
  if (
    aBytes.length === bBytes.length &&
    typeof subtle.timingSafeEqual === "function"
  ) {
    return subtle.timingSafeEqual(aBytes, bBytes);
  }

  // Portable fallback (XOR over max length; length mismatch still returns false).
  let result = aBytes.length === bBytes.length ? 0 : 1;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    result |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return result === 0;
}

export async function verifyApiToken(
  token: string,
  env: Env
): Promise<boolean> {
  const secret = env.API_TOKEN;
  if (!secret || !token) return false;
  return constantTimeEquals(token.trim(), secret);
}
