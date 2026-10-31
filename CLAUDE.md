# Script Library: agent notes

Read README.md first. Public site: https://piscuj.github.io/userscript-library/ (GitHub Pages, repo Piscuj/userscript-library, deployed by Actions on push to `main`).

- `scripts/<id>/script.user.js` is canonical. Do not rebuild releases from older copies elsewhere on this PC. The Codex-era `integration-sources/` and `prepare-control-centre.mjs` in `Documents/ChatGPT/Calories balance analysis/publish/` are stale and must not be used.
- Import new builds only through `tools/retarget.mjs`. If it reports that a reporter rewrite didn't match, the bundled reporter changed shape. Inspect it; don't loosen the patterns.
- Keep each script's `@name`/`@namespace` stable. Bump `@version` for every published change and add matching `changes.json` notes (the build enforces this).
- Run `npm test` and `npm run build` before committing. Check UI changes with `npm run preview` at http://127.0.0.1:4180/userscript-library/. Installed-version detection needs real Tampermonkey on the live origin, so state when that wasn't verified.
- After pushing, confirm the Pages deployment and fetch the changed `script.meta.js` from the live site. A push alone isn't verification.
- Script feature code lives in the source projects (`Documents/ChatGPT/<project>/`). Fix bugs there, then import.
