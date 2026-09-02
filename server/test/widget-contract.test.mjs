import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_PATH = path.resolve(TEST_DIR, "..", "public", "widget", "job-cards.html");

function loadWidgetHarness() {
  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "widget module script should exist");

  const root = {
    innerHTML: "",
    attributes: new Map(),
    addEventListener() {},
    querySelector() { return null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
  };
  const context = {
    console,
    TextEncoder,
    URL,
    Element: class Element {},
    HTMLButtonElement: class HTMLButtonElement {},
    document: { getElementById: () => root },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: true }),
      openai: undefined,
    },
  };
  vm.runInNewContext(`${script}\nglobalThis.__renderJobs = renderJobs;`, context);
  return { root, renderJobs: context.__renderJobs };
}

test("renders distinct structured states instead of presenting failures as no results", () => {
  const cases = [
    ["no_results", "No matching jobs found."],
    ["invalid_request", "could not be processed"],
    ["location_unavailable", "Current location is unavailable"],
    ["unavailable", "temporarily unavailable"],
  ];

  for (const [status, expectedText] of cases) {
    const { root, renderJobs } = loadWidgetHarness();
    renderJobs({
      structuredContent: {
        type: "application/json",
        data: { status, appliedFilters: { query: "engineer", limit: 6 }, totalResults: 0, jobs: [] },
      },
    });
    assert.match(root.innerHTML, new RegExp(expectedText, "i"));
    if (status !== "no_results") assert.doesNotMatch(root.innerHTML, /No matching jobs found/i);
    assert.equal(root.attributes.get("aria-busy"), "false");
  }
});

test("does not disguise malformed or contradictory successful output", () => {
  for (const payload of [
    null,
    { type: "application/json", data: { jobs: [] } },
    {
      type: "application/json",
      data: { status: "ok", appliedFilters: { query: "engineer", limit: 6 }, totalResults: 0, jobs: [] },
    },
  ]) {
    const { root, renderJobs } = loadWidgetHarness();
    renderJobs(payload);
    assert.match(root.innerHTML, /Unable to display job listings right now/i);
    assert.doesNotMatch(root.innerHTML, /No matching jobs found/i);
  }
});
