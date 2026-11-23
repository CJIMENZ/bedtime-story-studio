import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPrivateStoryRelease } from "../release-gate.mjs";

const playerRepo = "example/private-player";
const legacyRepo = "example/old-stories";
const legacyProbeUrls = [
  "https://example.github.io/old-stories/audio/synthetic-a.mp3",
  "https://example.github.io/old-stories/audio/synthetic-b.mp3",
];
const token = "synthetic-test-token";

function response(status, json = {}) {
  return {
    status,
    json: async () => json,
    body: { cancel: async () => {} },
  };
}

function mockFetch({ repoOverrides = {}, pageStatuses = {}, probeStatuses = [403, 404],
                     rejectOn = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (rejectOn && url.includes(rejectOn)) throw Error("Synthetic network failure");
    if (url.startsWith("https://api.github.com/repos/")) {
      const route = url.replace("https://api.github.com/repos/", "");
      const isPages = route.endsWith("/pages");
      const repo = isPages ? route.slice(0, -6) : route;
      if (isPages) return response(pageStatuses[repo] ?? 404);
      return response(200, {
        full_name: repo, private: true, visibility: "private",
        has_pages: false, ...repoOverrides[repo],
      });
    }
    const index = legacyProbeUrls.indexOf(url);
    return response(index < 0 ? 500 : (probeStatuses[index] ?? 404));
  };
  return { fetchImpl, calls };
}
const input = (fetchImpl, extra = {}) => ({
  playerRepo, legacyRepo, legacyProbeUrls, token, fetchImpl, ...extra,
});

test("all source and destination repos private, Pages disabled, and denied old audio routes pass", async () => {
  const { fetchImpl, calls } = mockFetch();
  assert.deepEqual(await verifyPrivateStoryRelease(input(fetchImpl)),
    { repositoriesChecked: 2, legacyRoutesChecked: 2 });
  const api = calls.filter(c => c.url.startsWith("https://api.github.com"));
  const legacy = calls.filter(c => c.url.startsWith("https://example.github.io"));
  assert.equal(api.length, 4);
  assert.equal(legacy.length, 2);
  assert.ok(api.every(c => c.options.headers.Authorization === "Bearer " + token));
  assert.ok(legacy.every(c => !Object.hasOwn(c.options.headers, "Authorization")));
  assert.ok(legacy.every(c => c.options.headers.Range === "bytes=0-15" &&
    c.options.redirect === "manual" && c.options.method === "GET"));
});

test("deduplicates source and destination when they are the same private repository", async () => {
  const { fetchImpl, calls } = mockFetch();
  const result = await verifyPrivateStoryRelease(input(fetchImpl, {
    playerRepo: legacyRepo,
  }));
  assert.equal(result.repositoriesChecked, 1);
  assert.equal(calls.filter(c => c.url.startsWith("https://api.github.com")).length, 2);
});

test("rejects publicly visible original repository even when the new player is private", async () => {
  const { fetchImpl, calls } = mockFetch({
    repoOverrides: { [legacyRepo]: { private: false, visibility: "public" } },
  });
  await assert.rejects(verifyPrivateStoryRelease(input(fetchImpl)),
    /not confirmed private/);
  assert.equal(calls.some(c => c.url.startsWith("https://example.github.io")), false);
});

test("rejects publicly visible player repository before any legacy probes", async () => {
  const { fetchImpl, calls } = mockFetch({
    repoOverrides: { [playerRepo]: { private: false, visibility: "public" } },
  });
  await assert.rejects(verifyPrivateStoryRelease(input(fetchImpl)),
    /not confirmed private/);
  assert.equal(calls.some(c => c.url.startsWith("https://example.github.io")), false);
});

test("rejects Pages if repo metadata says enabled or Pages endpoint remains present", async () => {
  const enabled = mockFetch({
    repoOverrides: { [legacyRepo]: { has_pages: true } },
  });
  await assert.rejects(verifyPrivateStoryRelease(input(enabled.fetchImpl)),
    /still reports GitHub Pages enabled/);
  const endpoint = mockFetch({ pageStatuses: { [legacyRepo]: 200 } });
  await assert.rejects(verifyPrivateStoryRelease(input(endpoint.fetchImpl)),
    /active or unverifiable Pages/);
  const insufficientAccess = mockFetch({ pageStatuses: { [legacyRepo]: 403 } });
  await assert.rejects(verifyPrivateStoryRelease(input(insufficientAccess.fetchImpl)),
    /active or unverifiable Pages/);
});

test("old audio bytes, redirects, and ambiguous server errors fail closed", async () => {
  for (const status of [200, 206, 302, 500]) {
    const { fetchImpl } = mockFetch({ probeStatuses: [status, 404] });
    await assert.rejects(verifyPrivateStoryRelease(input(fetchImpl)),
      /legacy route 1 is accessible, redirected or inconclusive/);
  }
});

test("accepts only explicit HTTPS github.io legacy path probes and never leaks credentials", async () => {
  const { fetchImpl, calls } = mockFetch();
  for (const urls of [
    [], ["http://example.github.io/old-stories/audio/synthetic.mp3"],
    ["https://evil.test/old-stories/audio/synthetic.mp3"],
    ["https://example.github.io/another-repo/audio/synthetic.mp3"],
    ["https://example.github.io/old-stories/audio/synthetic.mp3?secret=x"],
    ["https://example.github.io/old-stories/audio/synthetic.mp3#part"],
    [legacyProbeUrls[0], legacyProbeUrls[0]],
  ]) {
    await assert.rejects(verifyPrivateStoryRelease(input(fetchImpl, {
      legacyProbeUrls: urls,
    })));
  }
  assert.equal(calls.length, 0);
});

test("missing token, mismatched repository identity, and network failures block release", async () => {
  const { fetchImpl } = mockFetch();
  await assert.rejects(verifyPrivateStoryRelease(input(fetchImpl, { token: "" })),
    /GitHub token/);
  const mismatch = mockFetch({
    repoOverrides: { [playerRepo]: { full_name: "other/project" } },
  });
  await assert.rejects(verifyPrivateStoryRelease(input(mismatch.fetchImpl)),
    /Unexpected repository identity/);
  const network = mockFetch({ rejectOn: "/pages" });
  await assert.rejects(verifyPrivateStoryRelease(input(network.fetchImpl)),
    /Could not complete private repository or Pages verification/);
  const probeDown = mockFetch({ rejectOn: "/audio/" });
  await assert.rejects(verifyPrivateStoryRelease(input(probeDown.fetchImpl)),
    /legacy route 1 could not be verified/);
});
