import {
  createInstanceClient,
  type InstanceClientDeps,
} from "../src/instance-client.js";
import type { WriteResult } from "../src/transport.js";

interface EditorConfig {
  theme: string | null;
  missing: number;
}

function makeDeps(
  state: Record<string, unknown>,
  overrides?: Partial<InstanceClientDeps>,
): InstanceClientDeps & {
  calls: { set: unknown[][]; remove: unknown[][]; onChange: unknown[][] };
} {
  const successResult: WriteResult = { success: true, revision: "r1" };
  const calls = {
    set: [] as unknown[][],
    remove: [] as unknown[][],
    onChange: [] as unknown[][],
  };
  return {
    getState: () => state,
    set: async (...args) => {
      calls.set.push(args);
      return successResult;
    },
    remove: async (...args) => {
      calls.remove.push(args);
      return successResult;
    },
    onChange: (...args) => {
      calls.onChange.push(args);
      return () => {};
    },
    calls,
    ...overrides,
  };
}

describe("createInstanceClient", () => {
  it("addresses literal-dot instance IDs and members across reads, writes, reset and subscription", async () => {
    const deps = makeDeps({
      app: {
        editor: {
          "theme.dark": "base",
          instances: {
            "panel.one": { "theme.dark": "override" },
            panel: { one: { "theme.dark": "wrong" } },
          },
        },
      },
    });
    const client = createInstanceClient<{ "theme.dark": string }>(
      "app.editor",
      "panel.one",
      deps,
    );
    expect(client.get("theme.dark")).toBe("override");
    await client.set("theme.dark", "changed");
    client.onChange("theme.dark", () => {});
    await client.reset();
    expect(deps.calls.set[0]?.[0]).toBe(
      "app.editor.instances[panel.one][theme.dark]",
    );
    expect(deps.calls.onChange[0]?.[0]).toBe(
      "app.editor.instances[panel.one][theme.dark]",
    );
    expect(deps.calls.remove[0]?.[0]).toBe("app.editor.instances[panel.one]");
  });

  it("get() reads from instance path when override exists", () => {
    const state = {
      editor: { instances: { vim: { theme: "dark" } }, theme: "light" },
    };
    const client = createInstanceClient<EditorConfig>(
      "editor",
      "vim",
      makeDeps(state),
    );
    expect(client.get("theme")).toBe("dark");
  });

  it("get() falls back to base path when no override", () => {
    const state = { editor: { instances: { vim: {} }, theme: "light" } };
    const client = createInstanceClient<EditorConfig>(
      "editor",
      "vim",
      makeDeps(state),
    );
    expect(client.get("theme")).toBe("light");
  });

  it("get() returns undefined when neither exists", () => {
    const state = { editor: { instances: { vim: {} } } };
    const client = createInstanceClient<EditorConfig>(
      "editor",
      "vim",
      makeDeps(state),
    );
    expect(client.get("missing")).toBe(undefined);
  });

  it("getOrDefault() returns default when missing", () => {
    const state = { editor: { instances: { vim: {} } } };
    const client = createInstanceClient<EditorConfig>(
      "editor",
      "vim",
      makeDeps(state),
    );
    expect(client.getOrDefault("missing", 42)).toBe(42);
  });

  it.each([
    [{ editor: { instances: { vim: { theme: null } }, theme: "light" } }, null],
    [{ editor: { instances: { vim: {} }, theme: null } }, null],
  ])("getOrDefault() preserves nullable override and base values", (state, expected) => {
    const client = createInstanceClient<EditorConfig>(
      "editor",
      "vim",
      makeDeps(state),
    );
    expect(client.getOrDefault("theme", "fallback")).toBe(expected);
  });

  it("set() writes to instance path", async () => {
    const deps = makeDeps({});
    const client = createInstanceClient<EditorConfig>("editor", "vim", deps);
    await client.set("theme", "dark");
    expect(deps.calls.set.length).toBe(1);
    expect(deps.calls.set[0][0]).toBe("editor.instances.vim.theme");
    expect(deps.calls.set[0][1]).toBe("dark");
  });

  it("set() uses defaultWriteLayer", async () => {
    const calls = {
      set: [] as unknown[][],
      remove: [] as unknown[][],
      onChange: [] as unknown[][],
    };
    const deps: InstanceClientDeps & { calls: typeof calls } = {
      getState: () => ({}),
      set: async (...args) => {
        calls.set.push(args);
        return { success: true };
      },
      remove: async (...args) => {
        calls.remove.push(args);
        return { success: true };
      },
      onChange: (...args) => {
        calls.onChange.push(args);
        return () => {};
      },
      defaultWriteLayer: "user",
      calls,
    };
    const client = createInstanceClient<EditorConfig>("editor", "vim", deps);
    await client.set("theme", "dark", { environment: "prod" });
    expect(calls.set[0][2]).toEqual({ layer: "user", environment: "prod" });
  });

  it("reset() removes the entire instance prefix", async () => {
    const deps = makeDeps({});
    const client = createInstanceClient<EditorConfig>("editor", "vim", deps);
    await client.reset({ layer: "tenant" });
    expect(deps.calls.remove.length).toBe(1);
    expect(deps.calls.remove[0][0]).toBe("editor.instances.vim");
    expect(deps.calls.remove[0][1]).toEqual({ layer: "tenant" });
  });

  it("onChange subscribes to instance-prefixed pattern", () => {
    const deps = makeDeps({});
    const values: Array<string | undefined> = [];
    const client = createInstanceClient<EditorConfig>("editor", "vim", deps);
    client.onChange("theme", (value) => values.push(value));
    expect(deps.calls.onChange[0][0]).toBe("editor.instances.vim.theme");
    const handler = deps.calls.onChange[0][1];
    if (typeof handler !== "function") throw new Error("Missing handler");
    handler([
      {
        action: "set",
        key: "editor.instances.vim.theme",
        value: "dark",
      },
      {
        action: "remove",
        key: "editor.instances.vim.theme",
        value: null,
      },
    ]);
    expect(values).toEqual(["dark", undefined]);
  });
});
