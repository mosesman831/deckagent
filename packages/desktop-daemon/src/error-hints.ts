const ERROR_HINTS = {
  PATH_PROTECTED: "Protected path; choose another file or adjust policy",
  PATH_DENIED: "Denied path; choose a permitted directory or adjust policy",
  PATH_UNTRUSTED: "Untrusted path; stay under a trusted directory or adjust policy",
  BUDGET_EXCEEDED: "Wait for budget window or raise limits in policy.json",
  DEVICE_OFFLINE: "Run: deckagent daemon --foreground",
  TOOL_DISABLED: "Enable the tool or adjust policy.json",
  NETWORK_DENIED: "Use an allowed host or adjust network policy",
  TERMINAL_SANDBOX_UNAVAILABLE:
    "Install bwrap/sandbox-exec or change terminal_mode in policy.json",
} as const;

type ErrorHintCode = keyof typeof ERROR_HINTS;

function isErrorHintCode(code: string | undefined): code is ErrorHintCode {
  return !!code && Object.prototype.hasOwnProperty.call(ERROR_HINTS, code);
}

export function getErrorHint(code: string | undefined): string | undefined {
  return isErrorHintCode(code) ? ERROR_HINTS[code] : undefined;
}

export function appendErrorHint(
  message: string,
  code: string | undefined,
): string {
  const hint = getErrorHint(code);
  if (!hint || message.includes("Hint:")) return message;
  return `${message} Hint: ${hint}.`;
}
