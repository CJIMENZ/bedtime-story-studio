// Release gate for Calcifer Board #128. This never reads or imports recordings.
// It deliberately fails closed: a successful synthetic player test is not a privacy release.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const DENIED = new Set([401, 403, 404, 410]);
const API = "https://api.github.com/repos/";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function pagesProbes(legacyRepo, urls) {
  requireCondition(Array.isArray(urls) && urls.length > 0 && urls.length <= 32,
    "Provide 1-32 explicit legacy Pages audio URLs for unauthenticated checks");
  const [owner, repo] = legacyRepo.split("/");
  const host = owner.toLowerCase() + ".github.io";
  const prefix = "/" + repo.toLowerCase() + "/";
  const seen = new Set();
  return urls.map((value, index) => {
    let uri;
    try { uri = new URL(value); } catch { throw new Error("Invalid legacy probe " + (index + 1)); }
    requireCondition(typeof value === "string" &&
      uri.protocol === "https:" && uri.hostname === host &&
      uri.pathname.toLowerCase().startsWith(prefix) &&
      !uri.username && !uri.password && !uri.port && !uri.search && !uri.hash,
    "Legacy probe " + (index + 1) + " must use the original github.io project path over HTTPS");
    requireCondition(!seen.has(uri.href), "Legacy probes must be unique");
    seen.add(uri.href);
    return uri.href;
  });
}

export async function verifyPrivateStoryRelease({
  playerRepo, legacyRepo, legacyProbeUrls, token, fetchImpl = fetch,
}) {
  requireCondition(REPO.test(playerRepo ?? "") && REPO.test(legacyRepo ?? ""),
    "Both the private player and the original repository must be specified");
  requireCondition(typeof token === "string" && token.length > 0,
    "A GitHub token with metadata and Pages read access to both repositories is required");
  const probes = pagesProbes(legacyRepo, legacyProbeUrls);
  const repositories = [...new Set([playerRepo, legacyRepo])];
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  for (const repo of repositories) {
    let metadata, pages;
    try {
      metadata = await fetchImpl(API + repo, {
        method: "GET", headers: apiHeaders, redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      requireCondition(metadata.status === 200, "Cannot verify repository " + repo);
      const details = await metadata.json();
      requireCondition(details.full_name?.toLowerCase() === repo.toLowerCase(),
        "Unexpected repository identity for " + repo);
      requireCondition(details.private === true && details.visibility === "private",
        "Repository " + repo + " is not confirmed private");
      requireCondition(details.has_pages === false,
        "Repository " + repo + " still reports GitHub Pages enabled");
      pages = await fetchImpl(API + repo + "/pages", {
        method: "GET", headers: apiHeaders, redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (error instanceof Error && /^(Cannot verify|Unexpected repository|Repository )/.test(error.message))
        throw error;
      throw new Error("Could not complete private repository or Pages verification for " + repo);
    }
    requireCondition(pages.status === 404,
      "Repository " + repo + " has an active or unverifiable Pages configuration");
    await pages.body?.cancel?.();
  }

  for (const [index, url] of probes.entries()) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Range: "bytes=0-15", "Cache-Control": "no-cache" },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error("Unauthenticated legacy route " + (index + 1) + " could not be verified");
    }
    const status = response.status;
    await response.body?.cancel?.();
    requireCondition(DENIED.has(status),
      "Unauthenticated legacy route " + (index + 1) +
      " is accessible, redirected or inconclusive (HTTP " + status + ")");
  }
  return { repositoriesChecked: repositories.length, legacyRoutesChecked: probes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let legacyProbeUrls;
  try { legacyProbeUrls = JSON.parse(process.env.STORY_LEGACY_PROBE_URLS ?? ""); }
  catch { legacyProbeUrls = null; }
  try {
    const result = await verifyPrivateStoryRelease({
      playerRepo: process.env.STORY_PLAYER_REPO,
      legacyRepo: process.env.STORY_LEGACY_REPO,
      legacyProbeUrls,
      token: process.env.STORY_GITHUB_TOKEN,
    });
    console.log("Release preflight passed: " + result.repositoriesChecked +
      " private repositories, " + result.legacyRoutesChecked + " denied legacy routes.");
  } catch (error) {
    console.error("Release preflight BLOCKED: " + error.message);
    process.exitCode = 1;
  }
}
