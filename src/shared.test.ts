import { describe, expect, test } from "bun:test";
import { DEFAULT_GROUPING, classifyTabs, parseGrouping, parseTargets, parseAssignments, parseCatalog, parsePlan, sanitizeUrl } from "./shared";

const tabs = [
  { id: 11, title: "Repository", url: "https://example.com/project" },
  { id: 12, title: "Issues", url: "https://example.com/project/issues" },
  { id: 13, title: "Unrelated", url: "https://example.net/" },
];
const choices = [{ id: "new:0", name: "Project", targetId: null }];
const destinations = [{ id: "browser:7", name: "Project", tabCount: 2 }];

describe("grouping preferences", () => {
  test("preserves all detail choices and user instructions", () => {
    for (const detail of ["broad", "balanced", "detailed"] as const) {
      expect(parseGrouping({ detail, instructions: "  Name groups in Spanish.  " }))
        .toEqual({ detail, instructions: "Name groups in Spanish." });
    }
  });
  test("rejects unknown, non-string and extra preferences", () => {
    for (const value of [
      { detail: "creative", instructions: "" },
      { detail: ["broad"], instructions: "" },
      { detail: "broad", instructions: "", allowTools: true },
    ]) expect(() => parseGrouping(value)).toThrow("Grouping preferences");
  });
  test("bounds instructions without silently truncating them", () => {
    expect(parseGrouping({ detail: "balanced", instructions: "a".repeat(2000) }).instructions.length).toBe(2000);
    expect(() => parseGrouping({ detail: "balanced", instructions: "a".repeat(2001) })).toThrow("2,000");
  });
});

describe("assignment boundary", () => {
  test("preserves a complete partition and deliberate singleton", () => {
    expect(parsePlan({ groups: [{ name: "Project", tabIds: [11, 12], targetId: null }], ungrouped: [13] }, tabs, []))
      .toEqual({ groups: [{ name: "Project", tabIds: [11, 12], targetId: null }], ungrouped: [13] });
  });
  test("rejects duplicate membership across group and ungrouped", () => {
    expect(() => parsePlan({ groups: [{ name: "Project", tabIds: [11, 12], targetId: null }], ungrouped: [12, 13] }, tabs, [])).toThrow("duplicate");
  });
  test("rejects omitted tabs instead of silently dropping them", () => {
    expect(() => parsePlan({ groups: [{ name: "Project", tabIds: [11, 12], targetId: null }], ungrouped: [] }, tabs, [])).toThrow("omitted");
  });
  test("rejects model-invented IDs", () => {
    expect(() => parsePlan({ groups: [{ name: "Project", tabIds: [11, 99], targetId: null }], ungrouped: [12, 13] }, tabs, [])).toThrow("unknown");
  });
  test("rejects single-tab groups and unnamed groups", () => {
    expect(() => parsePlan({ groups: [{ name: "Project", tabIds: [11], targetId: null }], ungrouped: [12, 13] }, tabs, [])).toThrow("invalid group");
    expect(() => parsePlan({ groups: [{ name: " ", tabIds: [11, 12], targetId: null }], ungrouped: [13] }, tabs, [])).toThrow("invalid group");
  });
  test("allows conservative abstention on every tab", () => {
    expect(parsePlan({ groups: [], ungrouped: [11, 12, 13] }, tabs, [])).toEqual({ groups: [], ungrouped: [11, 12, 13] });
  });
});

describe("model assignment map", () => {
  test("preserves large browser IDs and explicit abstentions", () => {
    const largeTabs = tabs.map((tab, index) => ({ ...tab, id: 727122900 + index }));
    expect(parseAssignments({ assignments: { "727122900": "new:0", "727122901": "new:0", "727122902": null } }, largeTabs, choices))
      .toEqual({ groups: [{ name: "Project", tabIds: [727122900, 727122901], targetId: null }], ungrouped: [727122902] });
  });
  test("rejects omission rather than implicitly abstaining", () => {
    expect(() => parseAssignments({ assignments: { "11": "new:0", "12": "new:0" } }, tabs, choices)).toThrow("omitted");
  });
  test("rejects invented assignments and singleton group names", () => {
    expect(() => parseAssignments({ assignments: { "11": null, "12": null, "13": null, "99": null } }, tabs, choices)).toThrow("unknown");
    expect(() => parseAssignments({ assignments: { "11": "new:0", "12": null, "13": null } }, tabs, choices)).toThrow("at least two");
  });
});

describe("catalog anchor allocation", () => {
  test("reassigns earlier choices so overlapping candidates get distinct pairs", () => {
    const candidates = [...tabs, { id: 14, title: "Other topic", url: "https://example.org/" }];
    const catalog = parseCatalog({ groups: [
      { name: "Flexible", tabIds: [11, 12, 13, 14] },
      { name: "Specific", tabIds: [11, 12] },
    ] }, candidates);
    expect(catalog.map(group => ({ name: group.name, tabIds: [...group.tabIds].sort((a, b) => a - b) })))
      .toEqual([{ name: "Flexible", tabIds: [13, 14] }, { name: "Specific", tabIds: [11, 12] }]);
  });
  test("rejects catalogs without enough distinct supporting tabs", () => {
    expect(() => parseCatalog({ groups: [
      { name: "One", tabIds: [11, 12] }, { name: "Two", tabIds: [11, 12] },
    ] }, tabs)).toThrow("cannot support");
  });
  test("rejects repeated or invented examples within a category", () => {
    expect(() => parseCatalog({ groups: [{ name: "One", tabIds: [11, 11] }] }, tabs)).toThrow("duplicate");
    expect(() => parseCatalog({ groups: [{ name: "One", tabIds: [11, 99] }] }, tabs)).toThrow("unknown");
  });
});

describe("two-stage assignment boundary", () => {
  const inputs = [
    ...tabs,
    { id: 14, title: "Fourth", url: "https://example.org/" },
    { id: 15, title: "Fifth", url: "https://example.org/fifth" },
    { id: 16, title: "Sixth", url: "https://example.org/sixth" },
  ];
  const discovery = { groups: [
    { name: "One", tabIds: [11, 12] }, { name: "Two", tabIds: [13, 14] },
  ] };
  test("rejects anchor reassignment even when the final partition is otherwise valid", async () => {
    const responses = [discovery, { assignments: {
      "11": "new:1", "12": "new:1", "13": "new:0", "14": "new:0", "15": null, "16": null,
    } }][Symbol.iterator]();
    await expect(classifyTabs(inputs, DEFAULT_GROUPING, [], async () => responses.next().value)).rejects.toThrow("supporting pair");
  });
  test("rejects an invented group even when it contains two valid tabs", async () => {
    const responses = [discovery, { assignments: {
      "11": "new:0", "12": "new:0", "13": "new:1", "14": "new:1", "15": "Invented", "16": "Invented",
    } }][Symbol.iterator]();
    await expect(classifyTabs(inputs, DEFAULT_GROUPING, [], async () => responses.next().value)).rejects.toThrow("invented a group");
  });
});

describe("existing group destinations", () => {
  test("accepts a single addition without reclassifying existing members", async () => {
    const plan = await classifyTabs([tabs[0]!], DEFAULT_GROUPING, destinations,
      async () => ({ assignments: { "11": "browser:7" } }));
    expect(plan).toEqual({ groups: [{ name: "Project", tabIds: [11], targetId: "browser:7" }], ungrouped: [] });
    expect(parsePlan(plan, [tabs[0]!], destinations)).toEqual(plan);
  });
  test("keeps identical destination names distinct", () => {
    expect(parseAssignments({ assignments: { "11": "browser:7", "12": "browser:8", "13": null } }, tabs, [
      { id: "browser:7", name: "Work", targetId: "browser:7" },
      { id: "browser:8", name: "Work", targetId: "browser:8" },
    ])).toEqual({ groups: [
      { name: "Work", tabIds: [11], targetId: "browser:7" },
      { name: "Work", tabIds: [12], targetId: "browser:8" },
    ], ungrouped: [13] });
  });
  test("rejects invented and repeated destination IDs", () => {
    expect(() => parsePlan({ groups: [
      { name: "Project", tabIds: [11], targetId: "browser:99" },
    ], ungrouped: [12, 13] }, tabs, destinations)).toThrow("unknown");
    expect(() => parsePlan({ groups: [
      { name: "Project", tabIds: [11], targetId: "browser:7" },
      { name: "Project", tabIds: [12], targetId: "browser:7" },
    ], ungrouped: [13] }, tabs, destinations)).toThrow("duplicate group target");
  });
  test("rejects renaming an existing browser group", () => {
    expect(() => parsePlan({ groups: [
      { name: "Renamed", tabIds: [11], targetId: "browser:7" },
    ], ungrouped: [12, 13] }, tabs, destinations)).toThrow("stay unchanged");
  });
  test("supports an existing destination and a genuinely new group together", async () => {
    const responses = [
      { groups: [{ name: "Research", tabIds: [12, 13] }] },
      { assignments: { "11": "browser:7", "12": "new:0", "13": "new:0" } },
    ][Symbol.iterator]();
    expect(await classifyTabs(tabs, DEFAULT_GROUPING, destinations, async () => responses.next().value)).toEqual({
      groups: [
        { name: "Project", tabIds: [11], targetId: "browser:7" },
        { name: "Research", tabIds: [12, 13], targetId: null },
      ], ungrouped: [],
    });
  });
  test("does not let a same-named existing group take a new group's supporting pair", async () => {
    const moreTabs = [...tabs, { id: 14, title: "Fourth", url: "https://example.org/" }];
    const responses = [
      { groups: [{ name: "Project", tabIds: [11, 12] }] },
      { assignments: { "11": "browser:7", "12": "browser:7", "13": "new:0", "14": "new:0" } },
    ][Symbol.iterator]();
    await expect(classifyTabs(moreTabs, DEFAULT_GROUPING, destinations, async () => responses.next().value))
      .rejects.toThrow("supporting pair");
  });
});

describe("destination metadata boundary", () => {
  test("preserves existing names longer than the new-name limit", () => {
    const targets = parseTargets([{ id: "browser:7", name: "P".repeat(120), tabCount: 2 }]);
    expect(parsePlan({ groups: [{ name: targets[0]!.name, tabIds: [11], targetId: "browser:7" }],
      ungrouped: [12, 13] }, tabs, targets).groups[0]!.name).toBe("P".repeat(120));
  });
  test("rejects duplicate identifiers and invalid destination counts", () => {
    expect(() => parseTargets([...destinations, ...destinations])).toThrow("distinct");
    expect(() => parseTargets([{ id: "browser:7", name: "Project", tabCount: 0 }])).toThrow("positive");
    expect(() => parseTargets([{ id: "new:0", name: "Project", tabCount: 2 }])).toThrow("distinct");
  });
  test("rejects old tab metadata inside the destination context", () => {
    expect(() => parseTargets([{ id: "browser:7", name: "Project", tabCount: 2,
      tabs: [{ id: 100, title: "Private old tab", url: "https://example.net/private" }] }])).toThrow("Grouping targets");
  });
});

describe("URL privacy boundary", () => {
  test("removes embedded credentials, query values and fragments", () => {
    expect(sanitizeUrl("https://alice:secret@example.com/project?token=private#private"))
      .toBe("https://example.com/project");
  });
  test("excludes local files and browser internal pages", () => {
    for (const url of ["file:///home/user/private.txt", "chrome://settings", "about:blank", "javascript:alert(1)", "not a url"]) {
      expect(sanitizeUrl(url)).toBeNull();
    }
  });
});
