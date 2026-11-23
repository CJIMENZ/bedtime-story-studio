import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { createStoryServer, loadPrivateCatalog } from "../server.mjs";

let server, root, base, cookie;
const sound = Buffer.from("ID3-private-fixture-only");
const originHeaders = () => ({ Origin: base });
const request = (path, options = {}) => fetch(base + path, options);
const privateHeaders = extra => ({ Cookie: cookie, ...extra });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "story-player-test-"));
  await writeFile(join(root, "fixture.mp3"), sound);
  await writeFile(join(root, "catalog.json"), JSON.stringify([
    { id: "test-one", title: "Private fixture chapter", file: "fixture.mp3", durationSeconds: 23 },
  ]));
  const salt = randomBytes(16).toString("hex");
  server = await createStoryServer({
    mediaRoot: root,
    manifestPath: join(root, "catalog.json"),
    passcodeSalt: salt,
    passcodeHash: scryptSync("correct-horse-staple", Buffer.from(salt, "hex"), 32).toString("hex"),
    sessionSecret: randomBytes(48).toString("base64url"),
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});
test("public shell contains no story metadata, and private APIs require sign-in", async () => {
  const shell = await request("/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(shell.headers.get("cache-control"), /no-store/);
  const body = await shell.text();
  assert.doesNotMatch(body, /Private fixture chapter|fixture\.mp3/);
  assert.equal((await request("/api/chapters")).status, 401);
  assert.equal((await request("/api/audio/test-one")).status, 401);
  assert.equal((await request("/docs/audio/chapter-01.mp3")).status, 404);
});
test("origin check, passcode validation, and strong session cookie", async () => {
  const invalid = await request("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: "correct-horse-staple" }),
  });
  assert.equal(invalid.status, 403);
  const wrong = await request("/api/login", {
    method: "POST", headers: { ...originHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: "wrong" }),
  });
  assert.equal(wrong.status, 401);
  const correct = await request("/api/login", {
    method: "POST", headers: { ...originHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: "correct-horse-staple" }),
  });
  assert.equal(correct.status, 200);
  const setCookie = correct.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  assert.match(cookie, /^story_session=[a-zA-Z0-9_-]{32}\.[a-zA-Z0-9_-]+$/);
});
test("chapter listing excludes filesystem paths; valid range requests stream privately", async () => {
  const list = await request("/api/chapters", { headers: privateHeaders() });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { chapters: [
    { id: "test-one", title: "Private fixture chapter", durationSeconds: 23 },
  ] });
  const unauthorized = await request("/api/audio/test-one", { headers: {
    Cookie: cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a"),
  } });
  assert.equal(unauthorized.status, 401);
  const full = await request("/api/audio/test-one", { headers: privateHeaders() });
  assert.equal(full.status, 200);
  assert.match(full.headers.get("cache-control"), /no-store/);
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), sound);
  const range = await request("/api/audio/test-one", {
    headers: privateHeaders({ Range: "bytes=3-8" }),
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 3-8/" + sound.length);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), sound.subarray(3, 9));
  const suffix = await request("/api/audio/test-one", {
    headers: privateHeaders({ Range: "bytes=-5" }),
  });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), sound.subarray(-5));
  const head = await request("/api/audio/test-one", {
    method: "HEAD", headers: privateHeaders({ Range: "bytes=0-2" }),
  });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
test("invalid paths and byte ranges cannot escape approved recordings", async () => {
  assert.equal((await request("/api/audio/unknown", { headers: privateHeaders() })).status, 404);
  assert.equal((await request("/api/audio/test-one", {
    headers: privateHeaders({ Range: "bytes=1-2,4-5" }),
  })).status, 416);
  assert.equal((await request("/api/audio/test-one", {
    headers: privateHeaders({ Range: "bytes=999-" }),
  })).status, 416);
  assert.equal((await request("/api/audio/..%2f..%2fetc", { headers: privateHeaders() })).status, 404);
  const invalid = join(root, "invalid.json");
  await writeFile(invalid, JSON.stringify([
    { id: "unsafe", title: "Unsafe", file: "../secret.mp3", durationSeconds: 20 },
  ]));
  await assert.rejects(loadPrivateCatalog(root, invalid), /Invalid private catalog/);
});
test("logout revokes the server-side session; same-origin check stops cross-site writes", async () => {
  const wrongOrigin = await request("/api/logout", {
    method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.test" },
  });
  assert.equal(wrongOrigin.status, 403);
  const logout = await request("/api/logout", {
    method: "POST", headers: privateHeaders(originHeaders()),
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await request("/api/chapters", { headers: privateHeaders() })).status, 401);
});
test("repeated incorrect passcodes trigger rate limiting", async () => {
  for (let i = 0; i < 8; i++) {
    const attempt = await request("/api/login", {
      method: "POST", headers: { ...originHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: "incorrect-" + i }),
    });
    assert.equal(attempt.status, 401);
  }
  const blocked = await request("/api/login", {
    method: "POST", headers: { ...originHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: "correct-horse-staple" }),
  });
  assert.equal(blocked.status, 429);
});
