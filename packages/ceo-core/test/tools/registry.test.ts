// packages/ceo-core/test/tools/registry.test.ts
import { describe, it, expect } from "vitest";
import { ToolRegistry, type ToolEntry } from "../../src/tools/registry.js";

const fakeCtx = {} as never; // handlers are never called in this suite

const entry = (name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({
  name, toolset: "file",
  schema: {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: { path: { type: "string", description: "a path" } }, required: ["path"] },
  },
  handler: async () => "ok",
  ...extra,
});

describe("ToolRegistry", () => {
  it("registers and looks up by name", () => {
    const r = new ToolRegistry();
    r.register(entry("read_file"));
    expect(r.get("read_file")?.toolset).toBe("file");
    expect(r.get("nope")).toBeUndefined();
  });

  it("later register of the same name replaces the earlier entry", () => {
    const r = new ToolRegistry();
    r.register(entry("read_file"));
    r.register(entry("read_file", { toolset: "patched" }));
    expect(r.get("read_file")?.toolset).toBe("patched");
    expect(r.entries()).toHaveLength(1);
  });

  it("names() lists every registered tool", () => {
    const r = new ToolRegistry();
    r.register(entry("a")); r.register(entry("b"));
    expect(r.names().sort()).toEqual(["a", "b"]);
  });
});
