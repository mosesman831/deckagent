import "./popup.css";
import type { StatusResponse } from "../../lib/messages.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusResponse;
  } catch {
    return null;
  }
}

function render(status: StatusResponse | null): void {
  const app = document.getElementById("app");
  if (!app) return;
  app.replaceChildren();

  app.appendChild(el("h1", undefined, "DeckAgent v2"));

  if (!status) {
    app.appendChild(el("p", { class: "status disconnected" }, "Background unavailable"));
    return;
  }

  const statusRow = el("div", { class: "row" });
  const dot = el("span", {
    class: status.daemonConnected ? "dot connected" : "dot disconnected",
    title: status.daemonConnected ? "Connected" : "Disconnected"
  });
  statusRow.appendChild(dot);
  statusRow.appendChild(
    el(
      "span",
      undefined,
      status.daemonConnected ? "Daemon connected" : "Daemon disconnected"
    )
  );
  app.appendChild(statusRow);

  app.appendChild(el("p", { class: "muted" }, status.daemonUrl));

  const toggleRow = el("label", { class: "row toggle" });
  const checkbox = el("input", { type: "checkbox", id: "enabled" }) as HTMLInputElement;
  checkbox.checked = status.enabled;
  checkbox.addEventListener("change", () => {
    void chrome.runtime
      .sendMessage({ type: "set_enabled", enabled: checkbox.checked })
      .then((next) => render(next as StatusResponse));
  });
  toggleRow.appendChild(checkbox);
  toggleRow.appendChild(el("span", undefined, "Extension enabled"));
  app.appendChild(toggleRow);

  app.appendChild(el("h2", undefined, "Adapters"));
  const list = el("ul", { class: "adapters" });
  for (const adapter of status.adapters) {
    const item = el("li");
    item.appendChild(
      el("span", { class: adapter.enabled ? "badge on" : "badge off" }, adapter.enabled ? "on" : "off")
    );
    item.appendChild(el("span", undefined, adapter.name));
    list.appendChild(item);
  }
  app.appendChild(list);
}

async function main() {
  const status = await fetchStatus();
  render(status);

  // Refresh status periodically while popup is open.
  setInterval(() => {
    void fetchStatus().then(render);
  }, 2000);
}

void main();
