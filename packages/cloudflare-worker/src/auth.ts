import type { Env } from "./types.js";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still perform a compare over the shorter length to avoid leaking
    // either length, then return false.
    const len = Math.min(a.length, b.length);
    let result = 1;
    for (let i = 0; i < len; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

export async function verifyApiToken(token: string, env: Env): Promise<boolean> {
  const secret = env.API_TOKEN;
  if (!secret || !token) return false;
  return constantTimeEquals(token.trim(), secret);
}
