#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$ROOT/tests"
BUILD_DIR="$ROOT/.output/chrome-mv3"
PORT=8765

# Build the extension
echo "[1/6] Building extension..."
cd "$ROOT"
npm run build

# Start a local HTTP server serving the test page
echo "[2/6] Starting local HTTP server on port $PORT..."
python3 -m http.server "$PORT" --directory "$TEST_DIR" &
HTTP_PID=$!

# Wait until the server is actually listening
for i in {1..20}; do
  if curl -sf http://127.0.0.1:"$PORT"/browser-test.html >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

cleanup() {
  echo "[6/6] Cleaning up..."
  kill "$HTTP_PID" 2>/dev/null || true
  if [[ -n "${CHROME_PID:-}" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Give the server a moment to start
sleep 1

# Branded Google Chrome ignores --load-extension. Prefer Chrome for Testing
# (downloaded by Puppeteer) or Chromium, where unpacked extensions load.
resolve_chrome() {
  if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
    echo "${CHROME_BIN}"
    return
  fi
  local cache="${PUPPETEER_CACHE_DIR:-$HOME/.cache/puppeteer}"
  local found=""
  if [[ -d "$cache/chrome" ]]; then
    found="$(find "$cache/chrome" -type f -path '*/chrome-linux64/chrome' 2>/dev/null | sort | tail -1 || true)"
  fi
  if [[ -n "$found" && -x "$found" ]]; then
    echo "$found"
    return
  fi
  local candidate
  for candidate in chromium chromium-browser google-chrome-stable google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
  echo "No Chrome binary found. Set CHROME_BIN to Chrome for Testing or Chromium." >&2
  exit 1
}

CHROME_BIN="$(resolve_chrome)"
echo "Using Chrome: $CHROME_BIN"

# Create a fresh user data dir
USER_DATA_DIR="$(mktemp -d)"

# Launch Chromium with the unpacked extension.
# --headless=new loads extensions on Chromium / Chrome for Testing.
echo "[3/6] Launching headless Chromium with extension..."
"$CHROME_BIN" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-features=Translate,PrivacySandboxSettings4 \
  --disable-extensions-except="$BUILD_DIR" \
  --load-extension="$BUILD_DIR" \
  --remote-debugging-port=9222 \
  --user-data-dir="$USER_DATA_DIR" \
  >"$TEST_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

# Wait for DevTools port
echo "[4/6] Waiting for DevTools protocol..."
for i in {1..30}; do
  if curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Run the test script via CDP
echo "[5/6] Running browser integration tests..."
cd "$ROOT"
npx tsx "$TEST_DIR/browser.test.ts"

echo "[✓] Browser integration tests passed."
