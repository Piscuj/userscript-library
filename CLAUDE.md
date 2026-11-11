# Script Library: agent notes

Read README.md first. Public site: https://piscuj.github.io/userscript-library/ (GitHub Pages, repo Piscuj/userscript-library, deployed by Actions on push to `main`).

- `scripts/<id>/script.user.js` is canonical: edit scripts here. The copies in `Documents/ChatGPT/` are old and must not be edited or imported from.
- Tests for Liftosaur Details and Pomelo to Fitatu are in the private repo `Piscuj/userscript-tests` (`C:/Users/bluec/Code/userscript-tests`), which reads the scripts from this checkout. Write the failing test there, run `pnpm test` there, and commit both repos. Nutrition Balance and the treadmill corrector are tested in `test/` here.
- Bump a version with `node tools/retarget.mjs <id> scripts/<id>/script.user.js --version X.Y.Z`; it updates every place the script carries it. Scripts built elsewhere are imported only through the same tool. If it reports that a reporter rewrite didn't match, the bundled reporter changed shape. Inspect it; don't loosen the patterns.
- Keep each script's `@name`/`@namespace` stable. Bump `@version` for every published change and add matching `changes.json` notes (the build enforces this).
- Run `npm test` and `npm run build` before committing. Check UI changes with `npm run preview` at http://127.0.0.1:4180/userscript-library/. Installed-version detection needs real Tampermonkey on the live origin, so state when that wasn't verified.
- After pushing, confirm the Pages deployment and fetch the changed `script.meta.js` from the live site. A push alone isn't verification.