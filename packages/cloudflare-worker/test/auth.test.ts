import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64UrlEncode,
  computeCodeChallenge,
  generatePkce,
  handleAuthGithub,
  parseAccessToken,
  randomHex,
} from '../src/auth.js';
import { fakeEnv } from './helpers.js';

test('randomHex returns lowercase hex of the requested byte length', () => {
  const hex = randomHex(32);
  assert.equal(hex.length, 64);
  assert.match(hex, /^[0-9a-f]+$/);
  assert.notEqual(randomHex(16), randomHex(16));
});

test('base64UrlEncode is URL-safe and unpadded', () => {
  assert.equal(base64UrlEncode(new Uint8Array([255, 255, 255])), '____');
  assert.equal(base64UrlEncode(new Uint8Array([1])), 'AQ');
  assert.equal(base64UrlEncode(new Uint8Array([])), '');
});

test('computeCodeChallenge matches the RFC 7636 test vector', async () => {
  // From RFC 7636 Appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await computeCodeChallenge(verifier);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('generatePkce produces a consistent verifier/challenge pair', async () => {
  const pair = await generatePkce();
  assert.equal(pair.state.length, 32);
  assert.equal(pair.codeVerifier.length, 64);
  assert.equal(pair.codeChallenge, await computeCodeChallenge(pair.codeVerifier));
});

test('parseAccessToken handles JSON and form-encoded bodies', () => {
  assert.equal(parseAccessToken('{"access_token":"abc","token_type":"bearer"}'), 'abc');
  assert.equal(parseAccessToken('access_token=xyz&scope=user&token_type=bearer'), 'xyz');
  assert.equal(parseAccessToken('error=bad_verification_code&error_description=x'), null);
  assert.equal(parseAccessToken('{not json'), null);
});

test('handleAuthGithub redirects to GitHub with PKCE parameters', async () => {
  const env = fakeEnv();
  const req = new Request('https://worker.example.com/auth/github?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb');
  const res = await handleAuthGithub(req, env);
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location, 'expected a Location header');
  const dest = new URL(location);
  assert.equal(dest.origin + dest.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(dest.searchParams.get('client_id'), 'test-client-id');
  assert.equal(dest.searchParams.get('scope'), 'user');
  assert.equal(dest.searchParams.get('response_type'), 'code');
  assert.equal(dest.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(dest.searchParams.get('code_challenge'));
  assert.ok(dest.searchParams.get('state'));
});

test('handleAuthGithub rejects a missing redirect_uri', async () => {
  const env = fakeEnv();
  const req = new Request('https://worker.example.com/auth/github');
  const res = await handleAuthGithub(req, env);
  assert.equal(res.status, 400);
});
