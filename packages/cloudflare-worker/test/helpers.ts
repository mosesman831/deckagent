/**
 * A minimal in-memory KVNamespace stand-in implementing the subset of the API
 * the Worker uses (get / put / delete). TTL options are accepted and ignored.
 */
export function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

export function fakeEnv() {
  return {
    DECK_KV: fakeKv(),
    GITHUB_CLIENT_ID: 'test-client-id',
    APP_NAME: 'DeckAgent',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
  };
}
