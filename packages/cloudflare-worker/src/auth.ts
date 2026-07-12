/**
 * GitHub OAuth using the PKCE (S256) flow.
 *
 * Flow:
 *   GET /auth/github?redirect_uri=...   -> redirect user to GitHub
 *   GET /auth/callback?code=...&state=  -> exchange code, mint our own token,
 *                                          redirect back to the caller's
 *                                          redirect_uri with ?access_token=
 */

import type { Env, GitHubUser, OAuthState, Session, TokenRecord } from './types.js';

const STATE_TTL_SECONDS = 600; // 10 minutes
const SESSION_TTL_SECONDS = 86400; // 24 hours

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/** Generate `nBytes` of randomness as a lowercase hex string. */
export function randomHex(nBytes: number): string {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Base64url-encode raw bytes (no padding). */
export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Compute the PKCE code_challenge = base64url(sha256(code_verifier)). */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

/** A fresh PKCE verifier/challenge pair plus an anti-forgery state value. */
export interface PkcePair {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const state = randomHex(16);
  const codeVerifier = randomHex(32); // 64 hex chars: within PKCE's 43-128 range
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  return { state, codeVerifier, codeChallenge };
}

/**
 * Parse an access token out of a GitHub token-exchange response body, which may
 * be JSON (`{"access_token":"..."}`) or form-encoded (`access_token=...&...`).
 */
export function parseAccessToken(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { access_token?: unknown };
      return typeof parsed.access_token === 'string' ? parsed.access_token : null;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(trimmed);
  return params.get('access_token');
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Step 1: `GET /auth/github?redirect_uri=...` */
export async function handleAuthGithub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get('redirect_uri');
  if (!redirectUri) {
    return jsonError(400, 'INVALID_ARGUMENTS', 'Missing required query parameter: redirect_uri');
  }
  if (!env.GITHUB_CLIENT_ID) {
    return jsonError(500, 'INTERNAL_ERROR', 'GITHUB_CLIENT_ID is not configured');
  }

  const { state, codeVerifier, codeChallenge } = await generatePkce();
  const stateRecord: OAuthState = {
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    created_at: Date.now(),
  };
  await env.DECK_KV.put(`oauth:state:${state}`, JSON.stringify(stateRecord), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const callbackUri = `${url.origin}/auth/callback`;
  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUri);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', 'user');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('code_challenge', codeChallenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  return Response.redirect(authorize.toString(), 302);
}

/** Step 2: `GET /auth/callback?code=...&state=...` */
export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return jsonError(400, 'INVALID_ARGUMENTS', 'Missing required query parameters: code and state');
  }

  const stateRaw = await env.DECK_KV.get(`oauth:state:${state}`);
  if (!stateRaw) {
    return jsonError(400, 'OAUTH_REQUIRED', 'OAuth state is missing or expired; please restart login');
  }
  // State is single-use.
  await env.DECK_KV.delete(`oauth:state:${state}`);
  const stateRecord = JSON.parse(stateRaw) as OAuthState;

  // Exchange the authorization code for a GitHub access token.
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: stateRecord.code_verifier,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const githubToken = parseAccessToken(await tokenRes.text());
  if (!githubToken) {
    return jsonError(401, 'OAUTH_REQUIRED', 'GitHub did not return an access token');
  }

  // Fetch the GitHub user profile. GitHub requires a User-Agent header.
  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': env.APP_NAME || 'DeckAgent',
    },
  });
  if (!userRes.ok) {
    return jsonError(401, 'OAUTH_REQUIRED', `Failed to fetch GitHub user (status ${userRes.status})`);
  }
  const user = (await userRes.json()) as GitHubUser;
  const userId = String(user.id);

  // Mint our own access token and persist the session.
  const accessToken = randomHex(32); // 64 hex chars
  const now = Date.now();
  const session: Session = {
    access_token: accessToken,
    github_username: user.login,
    avatar_url: user.avatar_url,
    device_id: null,
    created_at: now,
  };
  const tokenRecord: TokenRecord = {
    user_id: userId,
    github_username: user.login,
    created_at: now,
  };
  await Promise.all([
    env.DECK_KV.put(`session:${userId}`, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
    env.DECK_KV.put(`token:${accessToken}`, JSON.stringify(tokenRecord), {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
  ]);

  // Redirect back to the original caller with the access token.
  const dest = new URL(stateRecord.redirect_uri);
  dest.searchParams.set('access_token', accessToken);
  return Response.redirect(dest.toString(), 302);
}
