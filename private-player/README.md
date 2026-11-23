# Private Story Library — deployment candidate

**Calcifer Board #128.** A standalone, zero-dependency Node 24 player with passcode sign-in, an owner-only chapter catalog and authenticated MP3 streaming (including seeking). This is **not deployed** and has not imported any recordings or private chapter names.

## Privacy boundary — required before launch

The existing bedtime-story-studio repository is **public** and its GitHub Pages site already exposes the original docs/audio MP3 files and docs/episodes.json. This PR adds generic software and synthetic test data only. Protecting the new server does **not** protect those old URLs, public commits or downloaded copies.

**Owner action required:** create a new private repository for the player, or change this repository to private; disable the old public Pages site; remove old publicly served assets; verify unauthenticated URLs no longer return audio; and review caching/search-index exposure. Material previously downloaded cannot be recalled. These source visibility changes are not accomplished by this PR. Do not deploy this to GitHub Pages.

## Private media contract

Use a private, read-only mounted directory (for example /srv/private-stories) containing approved MP3s and catalog.json. The application never loads public GitHub URLs or serves the docs directory. Both paths must be absolute. Example **synthetic** manifest, not a real episode:

~~~json
[
  { "id": "example", "title": "Example story", "file": "example.mp3", "durationSeconds": 120 }
]
~~~

Only MP3 basenames are accepted. Traversal, external URLs, absolute paths, duplicate IDs, unsupported extensions and symlink targets outside the media directory are rejected. The chapter API omits filesystem paths.

### Required secret configuration

- STORY_MEDIA_ROOT — absolute private directory containing MP3s
- STORY_MANIFEST_PATH — absolute path to its private catalog.json
- STORY_PASSCODE_SALT — random hexadecimal salt of at least 16 bytes
- STORY_PASSCODE_HASH — 32-byte scrypt-derived passcode hash, hexadecimal
- STORY_SESSION_SECRET — random secret at least 32 characters
- HOST — defaults to 127.0.0.1 (no direct internet exposure)
- PORT — defaults to 3000

Generate the salt/hash/secret offline with Node crypto.randomBytes and scryptSync. Put sensitive values in the deployment secret manager, not Git or shell history. Do not commit private manifests, recordings or tokens.

### Tests and start

~~~sh
node --version  # Node 24 or newer
cd private-player
npm test
npm run check
npm start
~~~

Use HTTPS termination via a trusted reverse proxy, secure routing, rate limiting at the edge and a read-only media mount. The cookie is HttpOnly, Secure and SameSite=Strict. Sessions are revocable, but stored in memory in a **single Node instance**. Restart revokes them. Multiple replicas/serverless require a shared revocable session store and additional tests.

The browser UI contains no chapter metadata until authenticated. The catalog and every stream request require an active session. No third-party analytics, script libraries or external image fetches. The player must not run from GitHub Pages or an unprotected public static host.

## Fail-closed release preflight (Board #128 follow-up)

The new, deliberately **manual** release check prevents passing off a working player as a private deployment while the source repository, the destination repository, or the old GitHub Pages routes remain publicly accessible. It makes **no GitHub settings changes** and never reads, copies, or prints recordings. Run this only after the owner has approved and performed the repository, Pages, and private-storage changes.

From private-player/, inject the following values through your approved local secrets/environment manager (do not paste secrets into tracked files or shell history):

| Environment variable | Meaning |
| --- | --- |
| STORY_PLAYER_REPO | The owner-approved destination repository (owner/name) |
| STORY_LEGACY_REPO | The original repository that held the published audio |
| STORY_GITHUB_TOKEN | GitHub token with metadata and Pages read access to **both** repositories |
| STORY_LEGACY_PROBE_URLS | JSON array of 1-32 previously served audio URLs on https://OWNER.github.io/REPO/... |

Then run `npm run release:check`. The script requires **both repositories to be private**, `has_pages=false` and no accessible Pages API configuration on either. It requests a short byte range from each legacy audio URL **without cookies or GitHub credentials**; only explicit HTTP denial (401/403/404/410) passes. A redirect, 200/206 response, network failure, missing visibility permission, or untested URL blocks release. It does not access family files on disk.

**Scope limit:** Legacy custom domains, additional old asset URLs, third-party caches, Git history, downloaded copies and authenticated production playback still need independent manual verification. A passing preflight does not certify those areas or grant permission to deploy. It cannot retract historical public copies. The repository and Pages privacy changes remain an owner decision, not a developer SQL/GitHub action.

## Release gates

1. Independent code/security review of cookie lifecycle, login rate limits, CSRF/origin handling, path validation, ranges and streaming.
2. Owner-approved private repo/media migration. Disable public Pages and independently verify no authenticated content remains publicly accessible. Do not claim historic downloads can be recalled.
3. Synthetic integration tests and real authenticated staging QA on phone, Fold cover/inner and desktop: login, playback, seeking, logout, expiry and unavailable media.
4. Owner approval of hosting, identity, backups, retention and access. Default to owner-only.
5. Only then deploy, link the private player to Board #128 and independently verify its production state.

## Discovery coverage

The existing repo has **nine numbered audio chapters and one special** in its previously published catalog. They were located, not copied or imported into this implementation. The private player starts with zero episodes until an owner provides private storage and an approved catalog. This PR does not complete the deployment or original-public-site remediation.

## Limits

This first release is single-owner/single-instance. A person who can legitimately play an audio file can still capture it; a browser's disabled download UI is not a DRM boundary. A passcode is not a replacement for a mature identity provider or two-factor authentication where the risk warrants them.
