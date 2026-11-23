import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const COOKIE = "story_session";
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_BODY = 2048;
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; media-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'",
};
function send(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...headers, "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body), ...extra,
  });
  res.end(body);
}
function sessionCookie(req) {
  const match = (req.headers.cookie ?? "").split(";").map(s => s.trim())
    .find(s => s.startsWith(COOKIE + "="));
  return match ? match.slice(COOKIE.length + 1) : "";
}
function mac(secret, id) {
  return createHmac("sha256", secret).update(id).digest("base64url");
}
function same(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sameOrigin(req) {
  try {
    const origin = req.headers.origin;
    const uri = new URL(origin);
    return (uri.protocol === "https:" || uri.protocol === "http:") &&
      uri.host === req.headers.host && uri.origin === origin;
  } catch { return false; }
}
async function bodyJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function validateCatalog(value) {
  if (!Array.isArray(value) || value.length > 200) throw Error("Invalid private catalog");
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.id) ||
        ids.has(row.id) || typeof row.title !== "string" ||
        row.title.trim().length < 1 || row.title.length > 160 ||
        typeof row.file !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,119}\.mp3$/i.test(row.file) ||
        row.file.includes("..") || basename(row.file) !== row.file ||
        !Number.isInteger(row.durationSeconds) ||
        row.durationSeconds < 1 || row.durationSeconds > 86400) throw Error("Invalid private catalog");
    ids.add(row.id);
    return { id: row.id, title: row.title.trim(), file: row.file,
      durationSeconds: row.durationSeconds };
  });
}
export async function loadPrivateCatalog(mediaRoot, manifestPath) {
  if (!isAbsolute(mediaRoot) || !isAbsolute(manifestPath))
    throw Error("Private media and manifest must use absolute paths");
  const root = await realpath(mediaRoot);
  const manifest = await realpath(manifestPath);
  if (!manifest.startsWith(root + sep)) throw Error("Manifest must be in private media root");
  return { root, chapters: validateCatalog(JSON.parse(await readFile(manifest, "utf8"))) };
}
function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}
export async function createStoryServer({ mediaRoot, manifestPath, passcodeSalt, passcodeHash, sessionSecret }) {
  if (!/^[0-9a-f]{32,}$/i.test(passcodeSalt ?? "") ||
      !/^[0-9a-f]{64}$/i.test(passcodeHash ?? "") ||
      typeof sessionSecret !== "string" || sessionSecret.length < 32)
    throw Error("Strong passcode salt, scrypt hash and session secret required");
  const { root, chapters } = await loadPrivateCatalog(mediaRoot, manifestPath);
  const byId = new Map(chapters.map(c => [c.id, c]));
  const sessions = new Map(), attempts = new Map();
  const secret = Buffer.from(sessionSecret);
  const hash = Buffer.from(passcodeHash, "hex"), salt = Buffer.from(passcodeSalt, "hex");
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  const authenticated = req => {
    const token = sessionCookie(req).split(".");
    if (token.length !== 2 || !/^[a-zA-Z0-9_-]{32}$/.test(token[0]) ||
        !same(mac(secret, token[0]), token[1])) return null;
    const expires = sessions.get(token[0]);
    if (!expires || expires <= Date.now()) { sessions.delete(token[0]); return null; }
    return token[0];
  };
  const cookie = (token, age) => COOKIE + "=" + token +
    "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + age;

  return createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://internal.invalid").pathname;
      if ((req.method === "GET" || req.method === "HEAD") &&
          Object.hasOwn(assets, pathname)) {
        const [filename, type] = assets[pathname];
        const bytes = await readFile(new URL("./public/" + filename, import.meta.url));
        res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": bytes.length });
        return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      if (req.method === "POST" && pathname === "/api/login") {
        if (!sameOrigin(req)) return send(res, 403, { error: "Forbidden" });
        const ip = req.socket.remoteAddress ?? "unknown", now = Date.now();
        const recent = (attempts.get(ip) ?? []).filter(at => now - at < 15 * 60000);
        if (recent.length >= 8) return send(res, 429, { error: "Try again later" });
        recent.push(now); attempts.set(ip, recent);
        let submitted;
        try { submitted = await bodyJson(req); }
        catch { return send(res, 400, { error: "Invalid request" }); }
        const passcode = submitted?.passcode;
        if (typeof passcode !== "string" || passcode.length > 256 ||
            !timingSafeEqual(scryptSync(passcode, salt, 32), hash))
          return send(res, 401, { error: "Incorrect passcode" });
        attempts.delete(ip);
        const id = randomBytes(24).toString("base64url");
        for (const [token, exp] of sessions) if (exp <= now) sessions.delete(token);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        sessions.set(id, now + SESSION_SECONDS * 1000);
        return send(res, 200, { authenticated: true }, {
          "Set-Cookie": cookie(id + "." + mac(secret, id), SESSION_SECONDS),
        });
      }
      if (req.method === "POST" && pathname === "/api/logout") {
        if (!sameOrigin(req)) return send(res, 403, { error: "Forbidden" });
        const id = authenticated(req);
        if (id) sessions.delete(id);
        return send(res, 200, { authenticated: false }, { "Set-Cookie": cookie("", 0) });
      }
      if (pathname.startsWith("/api/")) {
        if (!authenticated(req)) return send(res, 401, { error: "Sign in required" });
        if (req.method === "GET" && pathname === "/api/chapters")
          return send(res, 200, { chapters: chapters.map(({ id, title, durationSeconds }) =>
            ({ id, title, durationSeconds })) });
        if (/^\/api\/audio\/[a-z0-9-]+$/.test(pathname) &&
            (req.method === "GET" || req.method === "HEAD")) {
          const chapter = byId.get(pathname.slice("/api/audio/".length));
          if (!chapter) return send(res, 404, { error: "Not found" });
          const candidate = resolve(root, chapter.file);
          const real = await realpath(candidate).catch(() => "");
          if (!real || real !== join(root, chapter.file))
            return send(res, 404, { error: "Not found" });
          const info = await stat(real);
          if (!info.isFile() || info.size < 1) return send(res, 404, { error: "Not found" });
          const range = parseRange(req.headers.range, info.size);
          if (!range) return send(res, 416, { error: "Invalid range" },
            { "Content-Range": "bytes */" + info.size });
          res.writeHead(range.partial ? 206 : 200, {
            ...headers, "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes",
            "Content-Disposition": 'inline; filename="chapter.mp3"',
            "Content-Length": range.end - range.start + 1,
            ...(range.partial ? {
              "Content-Range": "bytes " + range.start + "-" + range.end + "/" + info.size,
            } : {}),
          });
          if (req.method === "HEAD") return res.end();
          const stream = createReadStream(real, { start: range.start, end: range.end });
          stream.on("error", () => res.destroy());
          stream.pipe(res);
          return;
        }
        return send(res, 404, { error: "Not found" });
      }
      return send(res, 404, { error: "Not found" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "Unavailable" });
      else res.destroy();
    }
  });
}
