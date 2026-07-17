import { Window } from "happy-dom";

const win = new Window({ url: "https://chat.deepseek.com/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).location = win.location;
(globalThis as any).Response = win.Response;
(globalThis as any).Request = win.Request;
(globalThis as any).Headers = win.Headers;
(globalThis as any).URLSearchParams = win.URLSearchParams;
(globalThis as any).FormData = win.FormData;
(globalThis as any).Blob = win.Blob;
(globalThis as any).WebSocket = win.WebSocket;
(globalThis as any).chrome = {
  runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
  tabs: { onUpdated: { addListener: () => {} }, query: async () => [] },
  scripting: { executeScript: async () => {} }
};
