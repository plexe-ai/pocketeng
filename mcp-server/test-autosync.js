#!/usr/bin/env node
/**
 * Unit tests for rsync exclude logic used by the MCP server (mirrors index.js patterns).
 */


let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}`);
  }
}

function assertEq(actual, expected, name) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
    console.log(`  ❌ ${name} — got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)}`);
  }
}

// Mirrored from index.js — keep in sync when changing exclude lists there.

const SYNC_EXCLUDES = [
  ".git", "node_modules", ".build", "DerivedData", "*.xcodeproj",
  ".DS_Store", "Pods", "build", "dist", ".next", "__pycache__",
  "*.pyc", "venv", ".venv", "env", ".env", "*.egg-info", ".tox",
  ".pytest_cache", "target", ".gradle", "*.o", "*.so", "*.dylib", ".claude",
];

function shouldExclude(filePath) {
  const parts = filePath.split("/");
  for (const pattern of SYNC_EXCLUDES) {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (filePath.endsWith(ext)) return true;
    } else {
      if (parts.includes(pattern)) return true;
    }
  }
  return false;
}

function buildExcludeArgs() {
  return SYNC_EXCLUDES.map((e) => `--exclude '${e}'`).join(" ");
}

// ─── Test 1: shouldExclude() ─────────────────────────────────────────────────

console.log("\n━━━ Test 1: shouldExclude() — basic patterns ━━━");

// Exact directory matches
assert(shouldExclude(".git"), "excludes .git");
assert(shouldExclude("node_modules"), "excludes node_modules");
assert(shouldExclude(".build"), "excludes .build");
assert(shouldExclude("DerivedData"), "excludes DerivedData");
assert(shouldExclude(".DS_Store"), "excludes .DS_Store");
assert(shouldExclude("Pods"), "excludes Pods");
assert(shouldExclude("build"), "excludes build");
assert(shouldExclude("dist"), "excludes dist");
assert(shouldExclude(".next"), "excludes .next");
assert(shouldExclude("__pycache__"), "excludes __pycache__");
assert(shouldExclude("venv"), "excludes venv");
assert(shouldExclude(".venv"), "excludes .venv");
assert(shouldExclude("env"), "excludes env");
assert(shouldExclude(".env"), "excludes .env");
assert(shouldExclude(".tox"), "excludes .tox");
assert(shouldExclude(".pytest_cache"), "excludes .pytest_cache");
assert(shouldExclude("target"), "excludes target");
assert(shouldExclude(".gradle"), "excludes .gradle");
assert(shouldExclude(".claude"), "excludes .claude");

// Glob patterns (*.ext)
assert(shouldExclude("MyApp.xcodeproj"), "excludes *.xcodeproj");
assert(shouldExclude("test.pyc"), "excludes *.pyc");
assert(shouldExclude("lib.o"), "excludes *.o");
assert(shouldExclude("lib.so"), "excludes *.so");
assert(shouldExclude("lib.dylib"), "excludes *.dylib");
assert(shouldExclude("some.egg-info"), "excludes *.egg-info");

console.log("\n━━━ Test 2: shouldExclude() — nested paths ━━━");

// Nested paths containing excluded dirs
assert(shouldExclude("src/node_modules/foo.js"), "excludes nested node_modules");
assert(shouldExclude("deep/path/.git/config"), "excludes nested .git");
assert(shouldExclude("project/build/output.js"), "excludes nested build");
assert(shouldExclude("project/__pycache__/module.pyc"), "excludes nested __pycache__");
assert(shouldExclude("app/.next/static/main.js"), "excludes nested .next");
assert(shouldExclude("src/.claude/settings.json"), "excludes nested .claude");

// Glob patterns in nested paths
assert(shouldExclude("deep/path/file.pyc"), "excludes nested *.pyc");
assert(shouldExclude("src/lib/mylib.so"), "excludes nested *.so");
assert(shouldExclude("obj/x86/file.o"), "excludes nested *.o");

console.log("\n━━━ Test 3: shouldExclude() — should NOT exclude ━━━");

// Files that should NOT be excluded
assert(!shouldExclude("src/main.js"), "allows src/main.js");
assert(!shouldExclude("README.md"), "allows README.md");
assert(!shouldExclude("package.json"), "allows package.json");
assert(!shouldExclude("src/components/App.tsx"), "allows .tsx files");
assert(!shouldExclude("lib/utils.py"), "allows .py files");
assert(!shouldExclude("config.yaml"), "allows .yaml files");
assert(!shouldExclude("Makefile"), "allows Makefile");
assert(!shouldExclude("src/index.html"), "allows .html files");
assert(!shouldExclude(".gitignore"), "allows .gitignore (not .git)");
assert(!shouldExclude("src/builder.js"), "allows 'builder' (not 'build')");
assert(!shouldExclude("environments/prod.json"), "allows 'environments' (not 'env')");
assert(!shouldExclude("distribution/app.js"), "allows 'distribution' (not 'dist')");
assert(!shouldExclude("targeted/file.txt"), "allows 'targeted' (not 'target')");

console.log("\n━━━ Test 4: shouldExclude() — edge cases ━━━");

// Edge cases
assert(!shouldExclude(""), "handles empty string");
assert(!shouldExclude("a"), "handles single char");
assert(shouldExclude(".git"), "handles root .git");
assert(shouldExclude("a/b/c/.git/d"), "handles deeply nested .git");
assert(!shouldExclude("my.git.repo"), "doesn't false-match .git in filename");
assert(!shouldExclude("not_a_build/file.txt"), "doesn't false-match build in compound name");
assert(shouldExclude("foo/venv/bar"), "matches venv in middle of path");

// Special characters in filenames
assert(!shouldExclude("src/file with spaces.ts"), "allows filenames with spaces");
assert(!shouldExclude("src/file'with'quotes.ts"), "allows filenames with single quotes");
assert(!shouldExclude("src/file\"with\"dquotes.ts"), "allows filenames with double quotes");
assert(!shouldExclude("src/日本語ファイル.ts"), "allows unicode filenames");

// Build-adjacent names that should NOT be excluded
assert(!shouldExclude("buildSrc/main.kt"), "allows buildSrc (gradle convention)");
assert(!shouldExclude("src/env.ts"), "allows env.ts file (not env dir)");

console.log("\n━━━ Test 5: buildExcludeArgs() ━━━");

const args = buildExcludeArgs();
assert(args.includes("--exclude '.git'"), "includes .git exclude");
assert(args.includes("--exclude 'node_modules'"), "includes node_modules exclude");
assert(args.includes("--exclude '*.pyc'"), "includes *.pyc exclude");
assert(args.includes("--exclude '.claude'"), "includes .claude exclude");
assertEq(
  args.split("--exclude").length - 1,
  SYNC_EXCLUDES.length,
  `has exactly ${SYNC_EXCLUDES.length} exclude args`
);

// ─── Test 6: Edge case — shouldExclude with tricky patterns ─────────────────

console.log("\n━━━ Test 6: shouldExclude() — tricky edge cases ━━━");

// Patterns that could cause false positives
assert(!shouldExclude("src/environment/config.ts"), "'environment' != 'env'");
assert(!shouldExclude("src/builder/main.go"), "'builder' != 'build'");
assert(!shouldExclude("src/distribution/app.js"), "'distribution' != 'dist'");
assert(!shouldExclude("src/targeting/rules.py"), "'targeting' != 'target'");
assert(!shouldExclude("src/vendor/lib.go"), "'vendor' != 'venv'");
assert(!shouldExclude("src/envoy/config.yaml"), "'envoy' != 'env'");

// But exact matches should still work in nested paths
assert(shouldExclude("project/env/bin/python"), "exact 'env' in path");
assert(shouldExclude("project/build/output.wasm"), "exact 'build' in path");
assert(shouldExclude("project/dist/bundle.js"), "exact 'dist' in path");
assert(shouldExclude("project/target/release/bin"), "exact 'target' in path");
assert(shouldExclude("project/venv/lib/python3"), "exact 'venv' in path");

// Multiple excluded patterns in one path
assert(shouldExclude("node_modules/.cache/babel/file.js"), "node_modules + nested");
assert(shouldExclude(".git/objects/pack/pack.idx"), ".git + nested");

// Root-level file with extension
assert(shouldExclude("something.pyc"), "*.pyc at root");
assert(shouldExclude("deeply/nested/path/cache.pyc"), "*.pyc deeply nested");

// Files that look like excluded dirs but aren't
assert(!shouldExclude("src/git-helper.js"), "'git-helper' != '.git'");
assert(!shouldExclude("src/podcast.js"), "no match for 'Pods' substring");

// ─── Summary ────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  FAILURES:");
  for (const f of failures) {
    console.log(`    ❌ ${f}`);
  }
}
console.log("═".repeat(60) + "\n");

process.exit(failed > 0 ? 1 : 0);
