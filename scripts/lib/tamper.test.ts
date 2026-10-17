import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildOpts, readArgs } from "./config.ts";
import type { Tests } from "./crap.ts";
import { changes } from "./diff.ts";
import { diffCoverageCheck } from "./diffcov.ts";
import { prePush, touchedTests } from "./hooks.ts";
import { tamperCheck } from "./tamper.ts";

const dirs: string[] = [];

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function write(repo: string, file: string, text: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}

function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function commit(repo: string, message = "snapshot") {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function tsRepo(files: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), "qg-tamper-"));
  dirs.push(repo);
  git(repo, "init", "-q");
  write(repo, ".gitignore", ".scratch/\n");
  write(repo, ".quality.toml", '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  commit(repo, "initial");
  return repo;
}

function opts(repo: string) {
  return buildOpts(readArgs(["check", "--repo", repo, "--staged", "--no-deps"]));
}

function tamper(repo: string) {
  const o = opts(repo);
  return tamperCheck(o, changes(o));
}

const rules = (repo: string) => tamper(repo).findings.map((f) => f.rule);

function removedMarker(reason: string, names: string[] = []) {
  const lines = [
    ["qg:test", `-removed ${reason}`].join(""),
    ...names.map((name) => ["qg:test", `-removed-name ${name}`].join("")),
  ];
  return `${lines.join("\n")}\n`;
}

function langRepo(lang: string, manifest: [string, string], files: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qg-tamper-${lang}-`));
  dirs.push(repo);
  git(repo, "init", "-q");
  write(repo, ".gitignore", ".scratch/\n");
  write(repo, ".quality.toml", `[project]\nlanguage = "${lang}"\nsrc = ["."]\nbase = "HEAD"\n`);
  write(repo, manifest[0], manifest[1]);
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  commit(repo, "initial");
  return repo;
}

describe("tamper/inline-suppression", () => {
  for (const [file, line] of [["evidence-eslint-disable-codex.ts", 1], ["evidence-eslint-disable-next-line.ts", 1]] as const) {
    test(`flags ${file} at its added directive`, () => {
      const repo = tsRepo();
      write(repo, "src/value.ts", readFileSync(join(import.meta.dir, "../fixtures", file), "utf8"));
      git(repo, "add", "-A");
      expect(tamper(repo).findings).toContainEqual(expect.objectContaining({ rule: "tamper/inline-suppression", file: "src/value.ts", line }));
    });
  }

  test("ignores unrelated ESLint rules and a directive inside a string", () => {
    const repo = tsRepo();
    write(repo, "src/value.ts", "// eslint-disable no-console\nexport const text = '// eslint-disable complexity';\nexport const template = `// eslint-disable max-depth`;\n");
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/inline-suppression");
  });

  test("flags a multiline block directive, a trailing directive, and a blanket disable", () => {
    const repo = tsRepo();
    write(repo, "src/value.ts", "/*\n * eslint-disable complexity\n */\nexport const a = 1; // eslint-disable-line max-depth\n// eslint-disable -- all rules\n");
    git(repo, "add", "-A");
    expect(tamper(repo).findings.filter((item) => item.rule === "tamper/inline-suppression").map((item) => item.line)).toEqual([2, 4, 5]);
  });

  test("does not flag an old directive when only code changes", () => {
    const repo = tsRepo({ "src/value.ts": "// eslint-disable complexity\nexport const value = 1;\n" });
    write(repo, "src/value.ts", "// eslint-disable complexity\nexport const value = 2;\n");
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/inline-suppression");
  });

  test("flags a new ast-grep suppression comment", () => {
    const repo = tsRepo();
    write(repo, "src/value.ts", "// ast-grep-ignore: empty-catch\nexport const value = 1;\n");
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/inline-suppression");
  });

  for (const [language, manifest, file, directive] of [
    ["py", "pyproject.toml", "src/value.py", "# noqa: F821"],
    ["py", "pyproject.toml", "src/value.py", "# ruff: noqa"],
    ["go", "go.mod", "src/value.go", "//gocyclo:ignore"],
    ["go", "go.mod", "src/value.go", "//nolint:gocyclo"],
  ] as const) {
    test(`flags ${language} ${directive}`, () => {
      const repo = tsRepo();
      write(repo, ".quality.toml", `[project]\nlanguage = "${language}"\nsrc = ["src"]\nbase = "HEAD"\n`);
      write(repo, manifest, language === "go" ? "module example.test/rules\n" : '[project]\nname = "rules"\nversion = "0.1.0"\n');
      write(repo, file, `${directive}\n`);
      git(repo, "add", "-A");
      expect(rules(repo)).toContain("tamper/inline-suppression");
    });
  }

  test("allows an unrelated Go nolint rule", () => {
    const repo = tsRepo();
    write(repo, ".quality.toml", '[project]\nlanguage = "go"\nsrc = ["src"]\nbase = "HEAD"\n');
    write(repo, "go.mod", "module example.test/rules\n");
    write(repo, "src/value.go", "package rules\n//nolint:errcheck\nfunc value() int { return 1 }\n");
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/inline-suppression");
  });

  test("ignores noqa text inside a Python docstring", () => {
    const repo = tsRepo();
    write(repo, ".quality.toml", '[project]\nlanguage = "py"\nsrc = ["src"]\nbase = "HEAD"\n');
    write(repo, "pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n');
    write(repo, "src/value.py", '"""\n# noqa: F821\n"""\nvalue = 1\n');
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/inline-suppression");
  });
});

describe("tamper/test-deleted", () => {
  test("blocks a test-only block deletion from the T1 eval", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'void test("removed", async () => {\n  await assert.rejects(run(), /invalid/u);\n  assert.equal(value, 1);\n});\n\nvoid test("kept", () => {\n  assert.equal(value, 2);\n});\n',
    });
    write(repo, "src/value.test.ts", 'void test("kept", () => {\n  assert.equal(value, 2);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-deleted");
  });

  test("detects the vanished header when a different test replaces the block", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed", () => {\n  expect(value).toEqual(1);\n});\ntest("kept", () => {});\n',
    });
    write(repo, "src/value.test.ts", 'test("replacement", () => {\n  expect(value).toEqual(2);\n});\ntest("kept", () => {});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-deleted");
  });

  test("does not read a regex .test(x) call or a method named it() as a test header", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("policy", () => {\n  expect(PATTERN.test(String(text))).toBe(false);\n  expect(api.it(1)).toBe(1);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("policy", () => {\n  expect(PATTERN.test(String(texts.ru))).toBe(false);\n  expect(api.it(2)).toBe(2);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/test-deleted");
  });

  test("allows a descriptive title rename for the same test", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("catalog sections share one screen with a toggle", () => {\n  expect(value).toEqual(1);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("catalog sections use two entry tiles without a toggle", () => {\n  expect(value).toEqual(1);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/test-deleted");
  });

  test("blocks a deleted test when source changed", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'import { test } from "node:test";\ntest("value", () => {});\n' });
    write(repo, "src/value.ts", "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-deleted");
  });

  test("accepts the staged removal reason from allow.md in the pre-commit hook entry", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'test("value", () => {});\n' });
    write(repo, "src/value.ts", "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    write(repo, ".scratch/quality/allow.md", `${["qg:test", "-removed replaced by the policy suite"].join("")}\n`);
    git(repo, "add", "-A");
    const o = buildOpts(readArgs(["hook", "pre-commit", "--repo", repo, "--staged", "--no-deps"]));
    const result = tamperCheck(o, changes(o));
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/test-deleted");
    expect(result.notices).toContain("note: bypass tamper/test-deleted allow.md replaced by the policy suite");
  });

  test("accepts an explicit staged removal reason", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'test("value", () => {});\n' });
    write(repo, "src/value.ts", "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    write(repo, ".scratch/quality/allow.md", `${["qg:test", "-removed obsolete case"].join("")}\n`);
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/test-deleted");
    expect(result.notices).toContain("note: bypass tamper/test-deleted allow.md obsolete case");
  });

  test("a removal reason does not bypass a weakened assertion in another test", () => {
    const repo = tsRepo({
      "src/value.ts": "export const value = 1;\n",
      "src/value.test.ts": 'test("removed", () => {\n  expect(value).toEqual(1);\n});\ntest("kept", () => {\n  expect(value).toEqual(1);\n});\n',
    });
    write(repo, "src/value.ts", "export const value = 2;\n");
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  expect(value).toBeTruthy();\n});\n');
    write(repo, ".scratch/quality/allow.md", `${["qg:test", "-removed obsolete case"].join("")}\n`);
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((finding) => finding.rule)).toContain("tamper/assertion-weakened");
    expect(result.notices).toEqual(["note: bypass tamper/test-deleted allow.md obsolete case"]);
  });

  test("rejects an empty reason and ignores allow.md outside check --staged and agent-stop", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'test("value", () => {});\n' });
    write(repo, "src/value.ts", "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    write(repo, ".scratch/quality/allow.md", "qg:test-removed\n");
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-deleted");
    write(repo, ".scratch/quality/allow.md", "qg:test-removed obsolete case\n");
    const full = buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"]));
    expect(tamperCheck(full, changes(full)).findings.map((f) => f.rule)).toContain("tamper/test-deleted");
  });

  test("reports a commit-message removal bypass with its reason", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'test("value", () => {});\n' });
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.ts", "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    commit(repo, "qg:test-removed obsolete case");
    const o = buildOpts(readArgs(["check", "--repo", repo, "--since", before, "--no-deps"]));
    const result = tamperCheck(o, changes(o));
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/test-deleted");
    expect(result.notices).toContain("note: bypass tamper/test-deleted commit-msg obsolete case");
  });

  test("blocks a whole deleted test block while another test remains", () => {
    const repo = tsRepo({
      "src/value.ts": "export const value = 1;\n",
      "src/value.test.ts": 'test("removed", () => {\n  expect(value).toEqual(1);\n});\ntest("kept", () => {});\n',
    });
    write(repo, "src/value.ts", "export const value = 2;\n");
    write(repo, "src/value.test.ts", 'test("kept", () => {});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-deleted");
  });
});

describe("tamper/test-skipped", () => {
  test("blocks a newly skipped test", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(repo, "src/value.test.ts", `${["test", ".skip"].join("")}('value', () => {});\n`);
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-skipped");
  });

  test("reports a test changed to skip without calling the block deleted", () => {
    const repo = tsRepo({
      "src/value.ts": "export const value = 1;\n",
      "src/value.test.ts": 'test("value", () => {\n  expect(value).toEqual(1);\n});\n',
    });
    write(repo, "src/value.ts", "export const value = 2;\n");
    write(repo, "src/value.test.ts", 'test.skip("value", () => {\n  expect(value).toEqual(1);\n});\n');
    git(repo, "add", "-A");
    const found = rules(repo).filter((rule) => rule === "tamper/test-skipped" || rule === "tamper/test-deleted");
    expect(found).toEqual(["tamper/test-skipped"]);
  });

  test("allows a normal added test", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(repo, "src/value.test.ts", 'test("value", () => {});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/test-skipped");
  });

  test("uses the Go adapter for _test.go and t.Skip", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-tamper-go-"));
    dirs.push(repo);
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".scratch/\n");
    write(repo, ".quality.toml", '[project]\nlanguage = "go"\nsrc = ["."]\nbase = "HEAD"\n');
    write(repo, "go.mod", "module example.test/tamper\n");
    write(repo, "value.go", "package value\nfunc Value() int { return 1 }\n");
    commit(repo, "initial");
    write(repo, "value.go", "package value\nfunc Value() int { return 2 }\n");
    write(repo, "value_test.go", 'package value\nfunc TestValue(t *testing.T) { t.Skip("later") }\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/test-skipped");
  });
});

describe("tamper/assertion-weakened", () => {
  test("blocks the codex T3 assert.equal to assert.ok hunk", () => {
    const repo = tsRepo({ "src/value.test.ts": "  assert.equal(repeated.item.updateId, 101);\n" });
    write(repo, "src/value.test.ts", "  assert.ok(repeated.item.updateId);\n");
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("blocks the multiline opus T3 assert.deepEqual to assert.ok hunk", () => {
    const repo = tsRepo({ "src/value.test.ts": '  assert.deepEqual(\n    first.map((r) => r.id),\n    ["A", "B"],\n  );\n' });
    write(repo, "src/value.test.ts", "  assert.ok(first.map((r) => r.id));\n");
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("blocks expect, unittest and bare Python weakening pairs", () => {
    const cases = [
      ["expect(value).toMatchObject(want);", "expect(value).not.toBeNull();"],
      ["self.assertDictEqual(value, want)", "self.assertIsNotNone(value)"],
      ["assert value == want", "assert value"],
    ];
    for (const [before, after] of cases) {
      const repo = tsRepo({ "src/value.test.ts": `${before}\n` });
      write(repo, "src/value.test.ts", `${after}\n`);
      git(repo, "add", "-A");
      expect(rules(repo)).toContain("tamper/assertion-weakened");
    }
  });

  test("allows an equally strong assertion replacement", () => {
    const repo = tsRepo({ "src/value.test.ts": "expect(value).toEqual(1);\n" });
    write(repo, "src/value.test.ts", "expect(value).toStrictEqual(1);\n");
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("allows a variable rename inside the same strong assertion", () => {
    const repo = tsRepo({ "src/value.test.ts": "assert.equal(value, 1);\n" });
    write(repo, "src/value.test.ts", "assert.equal(result, 1);\n");
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("allows assertion evidence moved into a new test", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'import { readFileSync } from "node:fs";\nconst SOURCE = readFileSync("src/value.ts", "utf8");\ntest("old harness", () => {\n  assert.equal(value, 1);\n  assert.match(SOURCE, /wired/);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("old harness", () => {\n  assert.equal(value, 1);\n});\n');
    write(repo, "src/value.behavior.test.ts", 'test("behavior", () => {\n  assert.equal(first, 1);\n  assert.equal(second, 2);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("blocks an ordinary assertion deletion despite assertions added elsewhere", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("old behavior", () => {\n  assert.equal(value, 1);\n  assert.equal(other, 2);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("old behavior", () => {\n  assert.equal(value, 1);\n});\n');
    write(repo, "src/value.behavior.test.ts", 'test("new behavior", () => {\n  assert.equal(first, 1);\n  assert.equal(second, 2);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });
});

describe("tamper/assertion-weakened removal bypass", () => {
  test("blocks a pure deletion of a named test with no marker at all", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a pure deletion naming every removed test, from allow.md", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed one", () => {\n  assert.equal(a, 1);\n  assert.equal(b, 2);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["removed one"]));
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
    expect(result.notices.some((n) => n.startsWith("note: bypass tamper/assertion-weakened allow.md") && n.includes("2 assert") && n.includes("removed one"))).toBe(true);
  });

  test("lifts assertion-weakened for a pure deletion naming every removed test, from the commit message", () => {
    const repo = tsRepo({ "src/value.test.ts": 'test("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n' });
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    commit(repo, removedMarker("migrated to the new primitive", ["removed one"]));
    const o = buildOpts(readArgs(["check", "--repo", repo, "--since", before, "--no-deps"]));
    const result = tamperCheck(o, changes(o));
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
    expect(result.notices.some((n) => n.startsWith("note: bypass tamper/assertion-weakened commit-msg") && n.includes("removed one"))).toBe(true);
  });

  test("still blocks a bare marker with no -name line", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive"));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a hunk whose removed assertion was not inside a named test definition", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("kept", () => {\n  assert.equal(a, 1);\n  assert.equal(b, 2);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(a, 1);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("cleanup", ["kept"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a hunk removing two tests when only one is named", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed one", () => { assert.equal(a, 1); });\ntest("removed two", () => { assert.equal(b, 2); });\ntest("kept", () => { assert.equal(c, 3); });\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => { assert.equal(c, 3); });\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("partial cleanup", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a mixed hunk even when the removed test is named", () => {
    const repo = tsRepo({
      "src/value.test.ts": 'test("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", '// replaced by a new helper\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a pure deletion of a named Python test", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py": "def test_removed():\n    assert value == 1\n    assert other == 2\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["test_removed"]));
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
    expect(result.notices.some((n) => n.startsWith("note: bypass tamper/assertion-weakened allow.md") && n.includes("test_removed"))).toBe(true);
  });

  test("still blocks a hunk whose removed lines start with a prior test's tail before a named test header", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'test("kept A", () => {\n  assert.equal(a, 1);\n  assert.equal(a2, 2);\n});\ntest("removed one", () => {\n  assert.equal(b, 2);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept A", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a hunk whose removed lines start with a prior Python test's tail before a named test header", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n    assert other == 2\n\n\ndef test_removed():\n    assert value == 3\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when only a comment precedes the named test header", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'test("kept A", () => {\n  assert.equal(a, 1);\n});\n// removed because flaky\ntest("removed one", () => {\n  assert.equal(b, 2);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept A", () => {\n  assert.equal(a, 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when only a decorator and a comment precede the named Python test header", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n\n\n@pytest.mark.skip\n# removed, flaky in CI\ndef test_removed():\n    assert other == 2\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a whole deleted TypeScript test file naming every test", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        '/**\n * value tests\n */\nimport { test } from "node:test";\n\ntest("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("removed two", () => {\n  assert.equal(b, 2);\n});\n',
    });
    rmSync(join(repo, "src/value.test.ts"));
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["removed one", "removed two"]));
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/test-deleted");
  });

  test("still blocks a whole deleted TypeScript test file when one test is not named", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'import { test } from "node:test";\n\ntest("removed one", () => {\n  assert.equal(a, 1);\n});\ntest("removed two", () => {\n  assert.equal(b, 2);\n});\n',
    });
    rmSync(join(repo, "src/value.test.ts"));
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a whole deleted Python test file with a module docstring naming every test", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py": '"""Module docstring."""\nimport pytest\n\n\ndef test_removed():\n    assert value == 1\n',
    });
    rmSync(join(repo, "test_value.py"));
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["test_removed"]));
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when a multi-line parametrize decorator precedes the named Python test header", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n\n\n@pytest.mark.parametrize(\n    \"x\",\n    [1, 2, 3],\n)\ndef test_removed(x):\n    assert x > 0\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("still blocks a hunk whose removed lines start with a prior test's tail before a decorator-covered named test header", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n    assert other == 2\n\n\n@pytest.mark.parametrize(\n    \"x\",\n    [1, 2, 3],\n)\ndef test_removed(x):\n    assert x > 0\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("never exempts a language with no test-definition adapter", () => {
    const repo = langRepo("go", ["go.mod", "module example.test/tamper\n"], {
      "value_test.go": "package value\nfunc TestRemoved(t *testing.T) {\n\tassert.Equal(t, 1, 1)\n\tassert.Equal(t, 2, 2)\n}\n\nfunc TestKept(t *testing.T) {\n\tassert.Equal(t, 3, 3)\n}\n",
    });
    write(repo, "value_test.go", "package value\nfunc TestKept(t *testing.T) {\n\tassert.Equal(t, 3, 3)\n}\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated to the new primitive", ["TestRemoved"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });
});

describe("tamper/assertion-weakened removal bypass naming helpers, fixtures, stub classes, and constants", () => {
  test("lifts assertion-weakened for a pure deletion naming a helper, a stub class, a fixture, a constant, and the tests sharing its hunk", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "@contextmanager\ndef _task():\n    yield\n\n\nclass _Clock:\n    def now(self):\n        return 1\n\n\n@pytest.fixture\ndef clock():\n    return _Clock()\n\n\n_SETSID_DEAF = True\n\n\ndef test_one():\n    assert clock\n    assert _SETSID_DEAF\n\n\ndef test_two():\n    assert clock\n\n\ndef test_kept():\n    assert True\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert True\n");
    write(
      repo,
      ".scratch/quality/allow.md",
      removedMarker("migrated off the legacy harness", ["_task", "_Clock", "clock", "_SETSID_DEAF", "test_one", "test_two"]),
    );
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((f) => f.rule)).not.toContain("tamper/assertion-weakened");
    expect(result.notices.some((n) => n.startsWith("note: bypass tamper/assertion-weakened allow.md") && n.includes("3 assert"))).toBe(true);
  });

  test("still blocks that same hunk when the helper is left unnamed", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "@contextmanager\ndef _task():\n    yield\n\n\nclass _Clock:\n    def now(self):\n        return 1\n\n\n@pytest.fixture\ndef clock():\n    return _Clock()\n\n\n_SETSID_DEAF = True\n\n\ndef test_one():\n    assert clock\n    assert _SETSID_DEAF\n\n\ndef test_two():\n    assert clock\n\n\ndef test_kept():\n    assert True\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert True\n");
    write(
      repo,
      ".scratch/quality/allow.md",
      removedMarker("migrated off the legacy harness", ["_Clock", "clock", "_SETSID_DEAF", "test_one", "test_two"]),
    );
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a pure deletion of two named helpers with no test among them", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py": "def helper_one():\n    assert flag_one\n\n\ndef helper_two():\n    assert flag_two\n\n\ndef test_kept():\n    assert True\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert True\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("dropped dead helpers", ["helper_one", "helper_two"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a pure deletion of a named stub class with no test", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py": "class _Clock:\n    def now(self):\n        assert False\n        return 1\n\n\ndef test_kept():\n    assert True\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert True\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("dropped the stub", ["_Clock"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened for a pure deletion naming a helper, a stub class, a constant, and the tests sharing a TypeScript hunk", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'function _task() {\n  return 1;\n}\n\n\nclass _Clock {\n  now() {\n    return 1;\n  }\n}\n\n\nconst _SETSID_DEAF = true;\n\n\ntest("removed one", () => {\n  assert.equal(a, 1);\n});\n\n\ntest("removed two", () => {\n  assert.equal(b, 2);\n});\n\n\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated off the legacy harness", ["_task", "_Clock", "_SETSID_DEAF", "removed one", "removed two"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("still blocks that same TypeScript hunk when the stub class is left unnamed", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'function _task() {\n  return 1;\n}\n\n\nclass _Clock {\n  now() {\n    return 1;\n  }\n}\n\n\nconst _SETSID_DEAF = true;\n\n\ntest("removed one", () => {\n  assert.equal(a, 1);\n});\n\n\ntest("removed two", () => {\n  assert.equal(b, 2);\n});\n\n\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated off the legacy harness", ["_task", "_SETSID_DEAF", "removed one", "removed two"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a hunk whose removed lines start with a prior test's tail before a named helper that follows", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n    assert other == 2\n\n\ndef helper_removed():\n    assert value == 3\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["helper_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a Python method removed from the start of a surviving class's body, even fully named", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py": "class TestFoo:\n    def test_removed(self):\n        assert False\n\n    def test_kept(self):\n        assert True\n",
    });
    write(repo, "test_value.py", "class TestFoo:\n    def test_kept(self):\n        assert True\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });

  test("still blocks a TypeScript test removed from the start of a surviving describe block, even fully named", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'describe("Foo", () => {\n  it("removed", () => {\n    assert.equal(a, 1);\n  });\n\n  it("kept", () => {\n    assert.equal(b, 2);\n  });\n});\n',
    });
    write(repo, "src/value.test.ts", 'describe("Foo", () => {\n  it("kept", () => {\n    assert.equal(b, 2);\n  });\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/assertion-weakened");
  });
});

describe("tamper/assertion-weakened removal bypass across multi-line headers, nested definitions, and leading blanks", () => {
  test("lifts assertion-weakened when a nested def inside a named helper's multi-line signature does not need its own name", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def helper_removed(\n    a: int,\n    b: int,\n) -> int:\n    def _inner():\n        assert a >= 0\n        return a + b\n    return _inner()\n\n\ndef test_kept():\n    assert True\n",
    });
    write(repo, "test_value.py", "def test_kept():\n    assert True\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("dropped the dead helper", ["helper_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when removed lines open with blank lines before a named class with nested methods", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n\n\n\n\nclass _FakeClock:\n    def __init__(self):\n        self.now = 0\n\n    def tick(self):\n        def _step():\n            assert self.now >= 0\n            return 1\n        self.now += _step()\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("dropped the fake clock", ["_FakeClock"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when a multi-line parametrize decorator has a quoted argument containing a stray paren", () => {
    const repo = langRepo("py", ["pyproject.toml", '[project]\nname = "rules"\nversion = "0.1.0"\n'], {
      "test_value.py":
        "def test_kept_a():\n    assert value == 1\n\n\n@pytest.mark.parametrize(\n    \"label\",\n    [\"weird(name\"],\n)\ndef test_removed(\n    label,\n) -> None:\n    assert label\n\n\ndef test_kept():\n    assert value == 1\n",
    });
    write(repo, "test_value.py", "def test_kept_a():\n    assert value == 1\n\n\ndef test_kept():\n    assert value == 1\n");
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["test_removed"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });

  test("lifts assertion-weakened when a named TypeScript test contains a nested function", () => {
    const repo = tsRepo({
      "src/value.test.ts":
        'test("removed one", () => {\n  function inner() {\n    return 1;\n  }\n  assert.equal(inner(), 1);\n});\ntest("kept", () => {\n  assert.equal(c, 3);\n});\n',
    });
    write(repo, "src/value.test.ts", 'test("kept", () => {\n  assert.equal(c, 3);\n});\n');
    write(repo, ".scratch/quality/allow.md", removedMarker("migrated", ["removed one"]));
    git(repo, "add", "-A");
    expect(rules(repo)).not.toContain("tamper/assertion-weakened");
  });
});

describe("tamper/mock-added", () => {
  test("notes a mock whose module did not change", () => {
    const repo = tsRepo({ "src/main.ts": "export const main = 1;\n", "src/dep.ts": "export const dep = 1;\n" });
    write(repo, "src/main.ts", "export const main = 2;\n");
    write(repo, "src/main.test.ts", `${["vi", '.mock("./dep"'].join("")}, () => ({}));\n`);
    git(repo, "add", "-A");
    expect(tamper(repo).notices).toEqual(["note: tamper/mock-added src/main.test.ts:+1 ./dep"]);
  });

  test("allows a mock of a module changed by the same patch", () => {
    const repo = tsRepo({ "src/dep.ts": "export const dep = 1;\n" });
    write(repo, "src/dep.ts", "export const dep = 2;\n");
    write(repo, "src/dep.test.ts", `${["vi", '.mock("./dep"'].join("")}, () => ({}));\n`);
    git(repo, "add", "-A");
    expect(tamper(repo).notices.filter((x) => x.includes("mock-added"))).toEqual([]);
  });

  test("notes codex and opus T4 local stubs that shadow imported source functions", () => {
    const codex = tsRepo({
      "src/queue.ts": "export async function loadQueueFile() { return {}; }\n",
      "src/queue.test.ts": 'import { loadQueueFile } from "./queue.ts";\ntest("reload", async () => {});\n',
    });
    write(codex, "src/queue.test.ts", 'import { loadQueueFile } from "./queue.ts";\ntest("reload", async () => {\n  const reloadQueueFile = async () => ({ document: {} });\n});\n');
    git(codex, "add", "-A");
    expect(tamper(codex).notices).toContain("note: tamper/mock-added src/queue.test.ts:+3 local stub shadows loadQueueFile from src/queue.ts");

    const opus = tsRepo({
      "src/store.ts": "export async function list() { return []; }\n",
      "src/store.test.ts": 'const { list } = await import("./store.ts");\ntest("list", async () => {});\n',
    });
    write(opus, "src/store.test.ts", 'const { list } = await import("./store.ts");\ntest("list", async () => {\n  let list = async () => [];\n});\n');
    git(opus, "add", "-A");
    expect(tamper(opus).notices).toContain("note: tamper/mock-added src/store.test.ts:+3 local stub shadows list from src/store.ts");
  });

  test("allows an added helper whose name does not shadow an imported function", () => {
    const repo = tsRepo({
      "src/store.ts": "export async function list() { return []; }\n",
      "src/store.test.ts": 'import { list } from "./store.ts";\ntest("list", async () => {});\n',
    });
    write(repo, "src/store.test.ts", 'import { list } from "./store.ts";\ntest("list", async () => {\n  const rowsForTest = async () => [];\n});\n');
    git(repo, "add", "-A");
    expect(tamper(repo).notices.filter((x) => x.includes("local stub"))).toEqual([]);
  });

  test("notes a local stub named like an exported function in changed source", () => {
    const repo = tsRepo({
      "src/store.ts": "export const list = async () => [];\n",
      "src/store.test.ts": 'test("list", async () => {});\n',
    });
    write(repo, "src/store.ts", "export const list = async () => [1];\n");
    write(repo, "src/store.test.ts", 'test("list", async () => {\n  function list() { return []; }\n});\n');
    git(repo, "add", "-A");
    expect(tamper(repo).notices).toContain("note: tamper/mock-added src/store.test.ts:+2 local stub shadows list from src/store.ts");
  });
});

describe("tamper/baseline-touched", () => {
  test("blocks a threshold change mixed with source", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(repo, ".quality.toml", `${readFileSync(join(repo, ".quality.toml"), "utf8")}\n[thresholds]\nmax_cc = 9\n`);
    write(repo, "src/value.ts", "export const value = 2;\n");
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/baseline-touched");
  });

  test("reports a standalone threshold change as a note", () => {
    const repo = tsRepo();
    write(repo, ".quality.toml", `${readFileSync(join(repo, ".quality.toml"), "utf8")}\n[thresholds]\nmax_cc = 9\n`);
    git(repo, "add", "-A");
    const result = tamper(repo);
    expect(result.findings.map((x) => x.rule)).not.toContain("tamper/baseline-touched");
    expect(result.notices.some((x) => x.startsWith("note: tamper/baseline-touched"))).toBe(true);
  });

  test("protects every configured narrowing key and names each changed key", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    const config = `[project]
language = "ts"
src = ["lib"]
base = "HEAD"

[thresholds]
max_cc = 9

[security]
gitleaks = false
audit = false

[hooks]
pre_push_test_cmd = "true"
pre_push_max_tests = 1
pre_push_timeout = 1

[secrets]
allow_users = ["private"]

[review]
jev = true

[knip]
ignore = ["src/**"]

[layers]
forbid = []

[docs]
globs = []
history_globs = []

[glossary]
allow = ["anything"]
`;
    write(repo, ".quality.toml", config);
    write(repo, "src/value.ts", "export const value = 2;\n");
    git(repo, "add", "-A");
    const result = tamper(repo);
    const message = result.findings.find((f) => f.rule === "tamper/baseline-touched")?.msg ?? "";
    for (const key of [
      "project.src", "thresholds.max_cc", "security.gitleaks", "security.audit",
      "hooks.pre_push_test_cmd", "hooks.pre_push_max_tests", "hooks.pre_push_timeout",
      "secrets.allow_users", "review.jev", "knip.ignore", "layers.forbid",
      "docs.globs", "docs.history_globs", "glossary.allow",
    ]) expect(message).toContain(key);

    const standalone = tsRepo();
    write(standalone, ".quality.toml", config);
    git(standalone, "add", "-A");
    const note = tamper(standalone).notices.find((line) => line.includes(".quality.toml")) ?? "";
    expect(note).toContain("project.src");
    expect(note).toContain("security.gitleaks");
  });

  test("blocks inline qg and gitleaks allow markers mixed with code and notes a marker-only file", () => {
    const marker = ["qg:", "allow fixture"].join("");
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(repo, "src/value.ts", `export const value = 2; // ${marker}\n`);
    git(repo, "add", "-A");
    expect(rules(repo)).toContain("tamper/baseline-touched");

    const clean = tsRepo();
    write(clean, "src/fixture.ts", `// ${marker}\n`);
    git(clean, "add", "-A");
    const result = tamper(clean);
    expect([result.findings.length, result.notices.some((x) => x.includes("baseline-touched"))]).toEqual([0, true]);

    const gitleaks = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(gitleaks, "src/value.ts", "export const value = 'secret'; // gitleaks:allow fixture\n");
    git(gitleaks, "add", "-A");
    expect(rules(gitleaks)).toContain("tamper/baseline-touched");
  });
});

describe("tamper/no-tests-ran", () => {
  function push(repo: string, before: string) {
    const head = git(repo, "rev-parse", "HEAD");
    return prePush(buildOpts(readArgs(["--repo", repo, "--no-deps"])), `refs/heads/main ${head} refs/heads/main ${before}\n`);
  }

  test("blocks pushed source with no touched or adjacent test", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.ts", "export const value = 2;\n");
    commit(repo, "change value");
    const result = push(repo, before);
    expect([result.ok, result.text.includes("tamper/no-tests-ran")]).toEqual([false, true]);
  });

  test("accepts a pushed commit with a reason for no test", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.ts", "export const value = 2;\n");
    commit(repo, ["qg:no", "-test generated constant only"].join(""));
    const result = push(repo, before);
    expect([result.ok, result.text.includes("note: bypass tamper/no-tests-ran commit-msg generated constant only")]).toEqual([true, true]);
    const report = JSON.parse(readFileSync(join(repo, ".scratch/quality/check.json"), "utf8"));
    expect(report.bypasses).toEqual(["note: bypass tamper/no-tests-ran commit-msg generated constant only"]);
    expect(readFileSync(join(repo, ".scratch/quality/check.md"), "utf8")).toContain("## Bypasses");
  });

  test("rejects qg:no-test without a non-empty reason", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.ts", "export const value = 2;\n");
    commit(repo, "qg:no-test");
    expect(push(repo, before).ok).toBe(false);
  });

  test("runs a test that imports the changed source even when its name differs", () => {
    const repo = tsRepo({
      "src/value.ts": "export const value = () => 1;\n",
      "src/value.test.ts": 'import { expect, test } from "bun:test";\nimport { value } from "./value.ts";\ntest("current", () => expect(value()).toBe(2));\n',
      "src/value-idempotency.test.ts": 'import { expect, test } from "bun:test";\nimport { value } from "./value.ts";\ntest("regression", () => expect(value()).toBe(1));\n',
    });
    write(repo, ".quality.toml", '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[hooks]\npre_push_test_cmd = "bun test {files}"\n[security]\ngitleaks = false\naudit = false\n');
    commit(repo, "test setup");
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/value.ts", "export const value = () => 2;\n");
    commit(repo, "change value");
    const result = push(repo, before);
    expect([result.ok, result.text.includes("touched tests: 1 by name, 1 by import"), result.text.includes("exit 1")]).toEqual([false, true, true]);
  });

  test("finds direct relative, require and tsconfig alias importers and respects the limit", () => {
    const repo = tsRepo({
      "src/value.ts": "export const value = 1;\n",
      "tests/a.test.ts": 'import { value } from "../src/value.ts";\n',
      "tests/b.test.ts": 'const value = require("../src/value");\n',
      "tests/c.test.ts": 'import { value } from "@acme/value";\n',
    });
    write(repo, "tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@acme/*":["src/*"]}}}\n');
    write(repo, ".quality.toml", '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[hooks]\npre_push_max_tests = 3\n');
    commit(repo, "import fixtures");
    expect(touchedTests(opts(repo), ["src/value.ts"])).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
  });

  test("checks tamper per pushed commit so a standalone baseline is a note", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'test("value", () => {});\n' });
    write(repo, ".scratch/quality/baseline.json", "{}\n");
    git(repo, "add", "-f", ".scratch/quality/baseline.json");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "baseline initial");
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, ".scratch/quality/baseline.json", '{"head":"next"}\n');
    git(repo, "add", "-f", ".scratch/quality/baseline.json");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "baseline only");
    write(repo, "src/value.ts", "export const value = 2;\n");
    write(repo, "src/value.test.ts", 'import { test } from "node:test";\ntest("value", () => {});\n');
    commit(repo, "source and test");
    const separate = push(repo, before);
    expect([separate.ok, separate.text.includes("note: tamper/baseline-touched")]).toEqual([true, true]);

    const mixed = tsRepo({ "src/value.ts": "export const value = 1;\n", "src/value.test.ts": 'import { test } from "node:test";\ntest("value", () => {});\n' });
    write(mixed, ".scratch/quality/baseline.json", "{}\n");
    git(mixed, "add", "-f", ".scratch/quality/baseline.json");
    git(mixed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "baseline initial");
    const mixedBefore = git(mixed, "rev-parse", "HEAD");
    write(mixed, ".scratch/quality/baseline.json", '{"head":"next"}\n');
    write(mixed, "src/value.ts", "export const value = 2;\n");
    write(mixed, "src/value.test.ts", 'import { test } from "node:test";\ntest("value", () => {});\n');
    git(mixed, "add", "-A");
    git(mixed, "add", "-f", ".scratch/quality/baseline.json");
    git(mixed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "mixed");
    expect(push(mixed, mixedBefore).text).toContain("tamper/baseline-touched");
  });
});

describe("cov/diff", () => {
  function coverageRepo(hits: [number, number][]) {
    const repo = tsRepo({ "src/value.ts": "export function value() {\n  return 1;\n}\n" });
    write(repo, "src/value.ts", "export function value() {\n  const a = 1;\n  const b = 2;\n  return 1;\n}\n");
    git(repo, "add", "-A");
    const lcov = join(repo, "lcov.info");
    writeFileSync(lcov, `SF:${join(repo, "src/value.ts")}\n${hits.map(([line, count]) => `DA:${line},${count}`).join("\n")}\nend_of_record\n`);
    const tests: Tests = { lcov, code: 0, failed: 0, skipped: false, red: false, used: true };
    const o = opts(repo);
    return { o, ch: changes(o), tests };
  }

  test("blocks fresh diff coverage below the threshold and lists uncovered lines", () => {
    const { o, ch, tests } = coverageRepo([[2, 1], [3, 0]]);
    const blocked = diffCoverageCheck(o, ch, tests, { lowCoverage: true, missingFiles: true });
    const noted = diffCoverageCheck(o, ch, tests, { lowCoverage: false, missingFiles: false });
    expect([blocked.findings[0].rule, blocked.findings[0].msg.includes("src/value.ts:3"), noted.findings.length, noted.notices[0].startsWith("note: cov/diff")]).toEqual(["cov/diff", true, 0, true]);
  });

  test("passes fresh diff coverage at the threshold", () => {
    const { o, ch, tests } = coverageRepo([[2, 1], [3, 1]]);
    const result = diffCoverageCheck(o, ch, tests, { lowCoverage: true, missingFiles: true });
    expect([result.findings.length, result.note.includes("100.0%")]).toEqual([0, true]);
  });

  test("counts changed sources without fresh lcov in pre-push and blocks missing full-gate coverage", () => {
    const repo = tsRepo({ "src/value.ts": "export const value = 1;\n" });
    write(repo, "src/value.ts", "export const value = 2;\n");
    git(repo, "add", "-A");
    const o = opts(repo);
    const noTests: Tests = { lcov: "", code: 0, failed: null, skipped: true, red: false, used: false };
    const prePush = diffCoverageCheck(o, changes(o), noTests, { lowCoverage: true, missingFiles: false });
    expect(prePush.notices).toContain("cov/diff: changed source files without lcov data: 1");

    const lcov = join(repo, "empty.lcov");
    writeFileSync(lcov, "");
    const fresh: Tests = { lcov, code: 0, failed: 0, skipped: false, red: false, used: true };
    const full = diffCoverageCheck(o, changes(o), fresh, { lowCoverage: true, missingFiles: true });
    expect(full.findings[0].msg).toContain("run tests with coverage first");
  });
});
