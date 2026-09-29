import { initService } from "./setup";
import "./schemas";
import { ALL_KEYS } from "./seed-data";
import { addLogEntry } from "./state";
import { renderActivityLog } from "./ui/activity-log";
import { renderConfigBrowser } from "./ui/config-browser";
import { renderEditor } from "./ui/editor";
import { renderInspector } from "./ui/inspector";
import { renderLayerStack } from "./ui/layer-stack";
import { renderLocationSelector } from "./ui/location-selector";
import { renderSessionPanel } from "./ui/session-panel";

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}

async function main(): Promise<void> {
  const { client, session, weaverConfig } = await initService();

  // Subscribe to all key changes for activity log
  for (const key of ALL_KEYS) {
    client.onChange(key, (deltas) => {
      for (const delta of deltas) {
        if (delta.key === key) {
          addLogEntry(`${key} changed to ${JSON.stringify(delta.value)}`);
        }
      }
    });
  }

  // Mount UI panels
  renderLayerStack(requireElement("layer-stack"), weaverConfig);
  renderLocationSelector(requireElement("location-selector"));
  renderConfigBrowser(requireElement("config-browser"), client, weaverConfig);
  renderInspector(requireElement("inspector"), client, weaverConfig);
  renderEditor(requireElement("editor"), client, session, weaverConfig);
  renderSessionPanel(requireElement("session-panel"), session, client);
  renderActivityLog(requireElement("activity-log"));

  // Typed namespace showcase
  interface UiConfig {
    theme: "light" | "dark" | "system";
    language: string;
  }
  const ui = client.namespace<UiConfig>("app.ui");
  console.log("[weaver-demo] Typed namespace — theme:", ui.get("theme"));
  console.log("[weaver-demo] Typed namespace — language:", ui.get("language"));

  addLogEntry("Weaver demo initialized");
}

main().catch(console.error);
