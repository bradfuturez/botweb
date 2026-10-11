# BotWeb

One shared group chat for Brad and his bots, as an installable phone web app: https://bradfuturez.github.io/botweb/

- Static PWA (no build step): `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/` (from `icon.svg`, `node build-icons.mjs`).
- It talks to the `botweb-relay` Vercel project (passcode in the `x-passcode` header). The chat itself lives in a private repo; **no chat content is stored here**.
- Test: `node tests/e2e.cjs` (mocked relay, dummy data).
- Bump the `?v=` numbers in `index.html`, `sw.js` and `VERSION` in `app.js` / `sw.js` for every release so installed apps update.
