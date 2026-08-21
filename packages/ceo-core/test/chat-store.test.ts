// packages/ceo-core/test/chat-store.test.ts
// Durable conversations + messages: CRUD, cascade delete, sidebar projection
// (messageCount + 80-char preview, pinned first) and regenerate truncation.
import { ChatStore } from "../src/chat-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

function mkStore(): ChatStore {
  return new ChatStore(join(mkdtempSync(join(tmpdir(), "robojex-chat-")), "chat.sqlite"));
}

test("create: defaults (title 新对话, pinned 0, gear balanced) and explicit title", () => {
  const s = mkStore();
  const c = s.create();
  expect(c.title).toBe("新对话");
  expect(c.pinned).toBe(0);
  expect(c.gear).toBe("balanced");
  expect(c.archived).toBe(0);
  expect(c.createdAt).toBeGreaterThan(0);
  const named = s.create("部署检查");
  expect(named.title).toBe("部署检查");
});

test("appendMessage + listMessages: chronological, notice excluded, updated_at touched", () => {
  const s = mkStore();
  const c = s.create();
  const before = c.updatedAt;
  s.appendMessage(c.id, { role: "user", content: "hi" });
  s.appendMessage(c.id, { role: "notice", content: "client-only noise" });
  const a = s.appendMessage(c.id, { role: "assistant", content: "hello", reasoning: "thinking...", tokensIn: 5, tokensOut: 7 });
  const msgs = s.listMessages(c.id);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]); // notice never listed
  expect(msgs[1]).toMatchObject({ id: a.id, content: "hello", reasoning: "thinking...", tokensIn: 5, tokensOut: 7, error: "" });
  expect(s.get(c.id)!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("listConversations: messageCount, 80-char preview, pinned first then updated_at DESC", () => {
  const s = mkStore();
  const a = s.create("a");
  const b = s.create("b");
  const pinned = s.create("pinned");
  s.appendMessage(a.id, { role: "user", content: "first question" });
  s.appendMessage(a.id, { role: "assistant", content: "answer for a" });
  s.appendMessage(b.id, { role: "user", content: "x".repeat(200) });
  s.update(pinned.id, { pinned: true });
  s.touch(b.id); // b is now the most recently updated
  const list = s.listConversations();
  expect(list.map((c) => c.title)).toEqual(["pinned", "b", "a"]);
  expect(list.find((c) => c.id === a.id)).toMatchObject({ messageCount: 2, preview: "answer for a" });
  expect(list.find((c) => c.id === b.id)).toMatchObject({ messageCount: 1 });
  expect(list.find((c) => c.id === b.id)!.preview.length).toBe(80); // preview capped
});

test("preview flattens newlines from the LATEST message", () => {
  const s = mkStore();
  const c = s.create();
  s.appendMessage(c.id, { role: "user", content: "one" });
  s.appendMessage(c.id, { role: "assistant", content: "line1\nline2" });
  expect(s.listConversations()[0]!.preview).toBe("line1 line2");
});

test("update: partial patch (title/pinned/archived), null on unknown id", () => {
  const s = mkStore();
  const c = s.create();
  const u = s.update(c.id, { title: "renamed", pinned: true });
  expect(u).toMatchObject({ title: "renamed", pinned: 1, archived: 0 });
  // boolean form (frontend wire) coerces
  expect(s.update(c.id, { archived: true })!.archived).toBe(1);
  expect(s.update("no-such-id", { title: "x" })).toBeNull();
  // empty title patch is ignored, not destructive
  expect(s.update(c.id, { title: "  " })!.title).toBe("renamed");
});

test("delete: cascades messages; deleteMessage removes one row", () => {
  const s = mkStore();
  const c = s.create();
  const m1 = s.appendMessage(c.id, { role: "user", content: "q" });
  const m2 = s.appendMessage(c.id, { role: "assistant", content: "a" });
  expect(s.deleteMessage(m1.id)).toBe(true);
  expect(s.listMessages(c.id).map((m) => m.id)).toEqual([m2.id]);
  expect(s.delete(m2.id + "x")).toBe(false);
  expect(s.delete(c.id)).toBe(true);
  expect(s.get(c.id)).toBeNull();
  expect(s.listMessages(c.id)).toEqual([]); // cascade wiped the messages
  expect(s.delete(c.id)).toBe(false);
});

test("truncateAfterLastUser: drops only the tail after the last user message", () => {
  const s = mkStore();
  const c = s.create();
  s.appendMessage(c.id, { role: "user", content: "q1" });
  s.appendMessage(c.id, { role: "assistant", content: "a1" });
  s.appendMessage(c.id, { role: "user", content: "q2" });
  s.appendMessage(c.id, { role: "assistant", content: "a2" });
  s.appendMessage(c.id, { role: "assistant", content: "a2b" });
  const removed = s.truncateAfterLastUser(c.id);
  expect(removed).toBe(2);
  expect(s.listMessages(c.id).map((m) => m.content)).toEqual(["q1", "a1", "q2"]); // q2 stays as history tail
  // no user message at all: nothing removed
  const c2 = s.create();
  s.appendMessage(c2.id, { role: "assistant", content: "orphan" });
  expect(s.truncateAfterLastUser(c2.id)).toBe(0);
});

test("findByTitle: latest match, null when absent", () => {
  const s = mkStore();
  const a = s.create("dup");
  const b = s.create("dup");
  s.touch(b.id);
  expect(s.findByTitle("dup")!.id).toBe(b.id);
  expect(a.id).not.toBe(b.id);
  expect(s.findByTitle("missing")).toBeNull();
});

test("updateMessage: patches content/tokens/error", () => {
  const s = mkStore();
  const c = s.create();
  const m = s.appendMessage(c.id, { role: "assistant", content: "partial" });
  const u = s.updateMessage(m.id, { content: "partial+rest", tokensOut: 9, error: "" });
  expect(u).toMatchObject({ content: "partial+rest", tokensOut: 9 });
  expect(s.listMessages(c.id)[0]!.content).toBe("partial+rest");
  expect(s.updateMessage("nope", { content: "x" })).toBeNull();
});

test("usageSince: per-local-day aggregation of assistant rows only", () => {
  const s = mkStore();
  const c = s.create();
  const now = Date.now();
  s.appendMessage(c.id, { role: "assistant", content: "r1", tokensIn: 100, tokensOut: 50, createdAt: now });
  s.appendMessage(c.id, { role: "assistant", content: "r2", tokensIn: 10, tokensOut: 5, createdAt: now - 86_400_000 }); // yesterday
  s.appendMessage(c.id, { role: "user", content: "q", tokensIn: 999, tokensOut: 999, createdAt: now }); // user rows never count
  const u = s.usageSince(now - 86_400_000);
  const today = u[u.length - 1]!;
  const yday = u[0]!;
  expect(today).toMatchObject({ tokensIn: 100, tokensOut: 50, calls: 1 });
  expect(yday).toMatchObject({ tokensIn: 10, tokensOut: 5, calls: 1 });
});
