import { describe, expect, it } from "vitest";
import { parseRefs } from "./parse.js";

describe("parseRefs", () => {
  it("extracts a same-repo reference", () => {
    expect(parseRefs("see #123 for context")).toEqual(["#123"]);
  });

  it("extracts a cross-repo reference", () => {
    expect(parseRefs("blocked by owner/repo#45")).toEqual(["owner/repo#45"]);
  });

  it("extracts a cross-repo reference with dotted/hyphenated names", () => {
    expect(parseRefs("dup of my-org/my.repo#7")).toEqual(["my-org/my.repo#7"]);
  });

  it("recognizes PR phrasing and normalizes to #n", () => {
    expect(parseRefs("fixed in PR #820")).toEqual(["#820"]);
    expect(parseRefs("see pull request #5")).toEqual(["#5"]);
    expect(parseRefs("merged pull/99")).toEqual(["#99"]);
  });

  it("dedupes repeated references preserving first-seen order", () => {
    expect(parseRefs("#10 then #20 then #10 again")).toEqual(["#10", "#20"]);
    expect(parseRefs("PR #5 and #5")).toEqual(["#5"]);
  });

  it("keeps same-repo and cross-repo for the same number distinct", () => {
    expect(parseRefs("#7 and owner/repo#7")).toEqual(["owner/repo#7", "#7"]);
  });

  it("ignores the issue's own number as a self-reference", () => {
    expect(parseRefs("this is #42 and relates to #43", 42)).toEqual(["#43"]);
  });

  it("does not treat a cross-repo number as a self-reference", () => {
    expect(parseRefs("see other/repo#42", 42)).toEqual(["other/repo#42"]);
  });

  it("ignores references inside fenced code blocks", () => {
    const text = ["before #1", "```", "ignore #999 in here", "```", "after #2"].join("\n");
    expect(parseRefs(text)).toEqual(["#1", "#2"]);
  });

  it("ignores references inside inline code spans", () => {
    expect(parseRefs("real #1 but `not #999` here")).toEqual(["#1"]);
  });

  it("does not match a # glued to a word (anchors)", () => {
    expect(parseRefs("see page#section for details")).toEqual([]);
  });

  it("returns an empty list for plain text with no references", () => {
    expect(parseRefs("just some prose with no issue numbers")).toEqual([]);
  });

  it("returns an empty list for null, undefined, or empty input", () => {
    expect(parseRefs(null)).toEqual([]);
    expect(parseRefs(undefined)).toEqual([]);
    expect(parseRefs("")).toEqual([]);
  });

  it("extracts multiple distinct forms from one body", () => {
    const text = "Dup of #10, also owner/repo#20, fixed in PR #30.";
    expect(parseRefs(text)).toEqual(["owner/repo#20", "#30", "#10"]);
  });
});
