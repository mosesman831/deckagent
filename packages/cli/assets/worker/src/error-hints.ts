const ERROR_HINTS = {
  DEVICE_OFFLINE: "Run: deckagent daemon --foreground",
} as const;

type ErrorHintCode = keyof typeof ERROR_HINTS;

function isErrorHintCode(code: string): code is ErrorHintCode {
  return Object.prototype.hasOwnProperty.call(ERROR_HINTS, code);
}

export function getErrorHint(code: string): string | undefined {
  return isErrorHintCode(code) ? ERROR_HINTS[code] : undefined;
}

export function appendErrorHint(message: string, code: string): string {
  const hint = getErrorHint(code);
  if (!hint || message.includes("Hint:")) return message;
  return `${message} Hint: ${hint}.`;
}
