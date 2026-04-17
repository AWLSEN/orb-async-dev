import { describe, expect, it } from "bun:test";
import { parseMention } from "../adapters/mention-parser.ts";

describe("parseMention", () => {
  it("parses @orb at start of comment", () => {
    const r = parseMention("@orb fix the login bug");
    expect(r?.taskText).toBe("fix the login bug");
  });

  it("parses @orb after greeting", () => {
    const r = parseMention("hey @orb, fix the login bug please");
    expect(r?.taskText).toBe("fix the login bug please");
  });

  it("returns null when handle does not appear", () => {
    expect(parseMention("just a regular comment")).toBeNull();
  });

  it("does not match @orbital (word boundary)", () => {
    expect(parseMention("@orbital mechanics are cool")).toBeNull();
  });

  it("does not match email-style .orb", () => {
    expect(parseMention("email me at foo@orb.io later")).toBeNull();
  });

  it("returns null when @orb has no task after it", () => {
    expect(parseMention("@orb")).toBeNull();
    expect(parseMention("thanks @orb.")).toBeNull();
    expect(parseMention("@orb   ")).toBeNull();
  });

  it("stops at paragraph boundary", () => {
    const r = parseMention("@orb fix the bug\n\nand also this other thing which is separate");
    expect(r?.taskText).toBe("fix the bug");
  });

  it("ignores mentions inside fenced code blocks", () => {
    const body = "Here's how you'd invoke it:\n\n```\n@orb fix this\n```\n\n(just an example).";
    expect(parseMention(body)).toBeNull();
  });

  it("ignores mentions inside inline code", () => {
    expect(parseMention("We used to type `@orb` but not anymore.")).toBeNull();
  });

  it("ignores mentions inside GitHub quote lines", () => {
    const body = "> @orb fix this (from previous comment)\n\nThat was a reply to an old bot message.";
    expect(parseMention(body)).toBeNull();
  });

  it("finds real mention below a quoted one", () => {
    const body = "> @orb fix this\n\n@orb actually fix it for real now";
    expect(parseMention(body)?.taskText).toBe("actually fix it for real now");
  });

  it("is case-insensitive for the handle", () => {
    expect(parseMention("@ORB fix it")?.taskText).toBe("fix it");
    expect(parseMention("@Orb fix it")?.taskText).toBe("fix it");
  });

  it("respects custom handle via opts", () => {
    expect(parseMention("@bot do thing", { handle: "bot" })?.taskText).toBe("do thing");
    expect(parseMention("@orb do thing", { handle: "bot" })).toBeNull();
  });

  it("strips leading punctuation from the task", () => {
    expect(parseMention("@orb: fix it")?.taskText).toBe("fix it");
    expect(parseMention("@orb - fix it")?.taskText).toBe("fix it");
    expect(parseMention("@orb, please fix it")?.taskText).toBe("please fix it");
  });

  it("empty or whitespace-only handle opt throws", () => {
    expect(() => parseMention("x", { handle: "" })).toThrow();
    expect(() => parseMention("x", { handle: "@" })).toThrow();
  });

  it("captures multi-line task text up to blank line", () => {
    const body = "@orb fix the /login 500 on unicode emails\nadd a regression test\nand mention it in the CHANGELOG";
    const r = parseMention(body);
    expect(r?.taskText).toBe(
      "fix the /login 500 on unicode emails\nadd a regression test\nand mention it in the CHANGELOG",
    );
  });

  it("handles CRLF newlines", () => {
    const body = "intro\r\n\r\n@orb fix it\r\n\r\ntrailer";
    expect(parseMention(body)?.taskText).toBe("fix it");
  });
});
