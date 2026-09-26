import type { ScopeInstance } from "@weaver-conf/config-types";
import type { NamespaceClientDeps } from "../src/namespace-client.js";
import { createNamespaceClient } from "../src/namespace-client.js";
import type { ConfigDelta } from "../src/types.js";

interface EditorConfig {
  fontSize: number;
  theme: "light" | "dark" | null;
  wordWrap: boolean;
}

function createDeps(
  baseState: Record<string, unknown>,
  scopedState: Record<string, unknown> = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const subscriptions: Array<{
    pattern: string;
    handler: (deltas: ConfigDelta[]) => void;
  }> = [];
  const deps: NamespaceClientDeps = {
    getState: (scope?: ScopeInstance[]) =>
      scope && scope.length > 0 ? scopedState : baseState,
    set: async (...args) => {
      calls.push({ method: "set", args });
      return { success: true };
    },
    setMany: async (...args) => {
      calls.push({ method: "setMany", args });
      return { success: true };
    },
    remove: async (...args) => {
      calls.push({ method: "remove", args });
      return { success: true };
    },
    onChange: (pattern, handler) => {
      subscriptions.push({ pattern, handler });
      return () => {};
    },
  };
  return { deps, calls, subscriptions };
}

const delta = (action: "set" | "remove", value: unknown): ConfigDelta => ({
  action,
  key: "editor.theme",
  value,
  layer: "default",
  environment: "default",
  timestamp: "2026-01-01T00:00:00.000Z",
});

describe("NamespaceClient", () => {
  it("reads keyed values and returns the namespace object without validation", () => {
    const state = {
      editor: { fontSize: 14, theme: "dark", wordWrap: true },
    };
    const { deps } = createDeps(state);
    const client = createNamespaceClient<EditorConfig>("editor", deps);

    expect(client.get("fontSize")).toBe(14);
    expect(client.getOrDefault("theme", "light")).toBe("dark");
    expect(client.getAll()).toEqual(state.editor);
  });

  it("returns defaults and an empty object for absent state", () => {
    const { deps } = createDeps({});
    const client = createNamespaceClient<EditorConfig>("editor", deps);

    expect(client.get("fontSize")).toBe(undefined);
    expect(client.getOrDefault("fontSize", 16)).toBe(16);
    expect(client.getAll()).toEqual({});
  });

  it("preserves null instead of applying a default", () => {
    const { deps } = createDeps({ editor: { theme: null } });
    const client = createNamespaceClient<EditorConfig>("editor", deps);
    expect(client.getOrDefault("theme", "light")).toBe(null);
  });

  it("prefixes set, setMany, and remove operations", async () => {
    const { deps, calls } = createDeps({});
    const client = createNamespaceClient<EditorConfig>("editor", deps);

    await client.set("fontSize", 18, { layer: "user" });
    await client.setMany({ theme: "light", wordWrap: false });
    await client.remove("theme", { layer: "default" });

    expect(calls).toEqual([
      { method: "set", args: ["editor.fontSize", 18, { layer: "user" }] },
      {
        method: "setMany",
        args: [
          { "editor.theme": "light", "editor.wordWrap": false },
          undefined,
        ],
      },
      {
        method: "remove",
        args: ["editor.theme", { layer: "default" }],
      },
    ]);
  });

  it("keeps literal-dot members distinct beneath a dotted namespace", async () => {
    const { deps, calls, subscriptions } = createDeps({
      app: {
        editor: {
          "theme.dark": "literal",
          theme: { dark: "nested" },
        },
      },
    });
    const client = createNamespaceClient<{
      "theme.dark": string;
      theme: object;
    }>("app.editor", deps);
    expect(client.get("theme.dark")).toBe("literal");
    await client.set("theme.dark", "new");
    await client.setMany({ "theme.dark": "next", theme: {} });
    await client.remove("theme.dark");
    client.onChange("theme.dark", () => {});
    expect(calls.map(({ args }) => args[0])).toEqual([
      "app.editor[theme.dark]",
      { "app.editor[theme.dark]": "next", "app.editor.theme": {} },
      "app.editor[theme.dark]",
    ]);
    expect(subscriptions[0]?.pattern).toBe("app.editor[theme.dark]");
  });

  it("preserves its generic through scoped and instance views", () => {
    const base = { editor: { theme: "light" } };
    const scoped = {
      editor: {
        theme: "dark",
        instances: { panel: { fontSize: 20 } },
      },
    };
    const { deps } = createDeps(base, scoped);
    const client = createNamespaceClient<EditorConfig>("editor", deps);
    const scopedClient = client.withScope([
      { scopeId: "project", value: "weaver" },
    ]);

    expect(scopedClient.get("theme")).toBe("dark");
    expect(scopedClient.instance("panel").get("fontSize")).toBe(20);
    expect(scopedClient.instance("panel").get("theme")).toBe("dark");
  });

  it("supports keyed and namespace-wide subscriptions", () => {
    const { deps, subscriptions } = createDeps({});
    const client = createNamespaceClient<EditorConfig>("editor", deps);
    const values: Array<EditorConfig["theme"] | undefined> = [];
    const batches: ConfigDelta[][] = [];

    client.onChange("theme", (value) => values.push(value));
    client.onChange((deltas) => batches.push(deltas));
    subscriptions[0]?.handler([delta("set", "dark"), delta("remove", null)]);
    subscriptions[1]?.handler([delta("set", "light")]);

    expect(subscriptions.map(({ pattern }) => pattern)).toEqual([
      "editor.theme",
      "editor.*",
    ]);
    expect(values).toEqual(["dark", undefined]);
    expect(batches).toHaveLength(1);
  });
});
