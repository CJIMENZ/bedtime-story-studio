import { createStoryServer } from "./server.mjs";
const { STORY_MEDIA_ROOT: mediaRoot, STORY_MANIFEST_PATH: manifestPath,
  STORY_PASSCODE_SALT: passcodeSalt, STORY_PASSCODE_HASH: passcodeHash,
  STORY_SESSION_SECRET: sessionSecret } = process.env;
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("PORT must be an integer between 1 and 65535");
const server = await createStoryServer({
  mediaRoot, manifestPath, passcodeSalt, passcodeHash, sessionSecret,
});
server.listen(port, host, () => console.log("Private story player listening on " + host + ":" + port));
