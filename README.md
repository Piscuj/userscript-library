# Script Library

Tampermonkey userscripts for Intervals.icu, Liftosaur, Pomelo and Fitatu, published at
**https://piscuj.github.io/userscript-library/**.

The library page shows each script's installed and published version. Click **Install** or **Update**, or **Update All**, to open Tampermonkey's install dialog. Each script then updates itself from this site through its `@updateURL`.

## How it works

- `scripts/<id>/script.user.js` is the published file and the source of truth. `changes.json` holds release notes per version, and `license.txt` is shipped next to the script.
- `catalog.json` lists the scripts shown on the page, with their title, summary, tags and usage notes.
- Every script bundles a small reporter and `@match`es the library page. When the page asks, the reporter replies with the installed version, so the page can show what's out of date. **Update All** asks one installed script to open the outdated scripts via `GM.openInTab`, which isn't popup-blocked. A single **Install** or **Update** click is a plain link that Tampermonkey intercepts.
- `build.mjs` validates every script and writes `dist/`. It checks identity, version, URLs, library `@match`, syntax and that release notes exist. A push to `main` runs the tests and deploys `dist/` to GitHub Pages (`.github/workflows/pages.yml`).

## Publish a script change

1. Edit `scripts/<id>/script.user.js` here. Tests for Liftosaur Details and Pomelo to Fitatu live in the private `userscript-tests` repo, which reads the scripts from this checkout; write the failing test there first.
2. Bump the version everywhere the script carries it:
   ```
   node tools/retarget.mjs <id> scripts/<id>/script.user.js --version X.Y.Z
   ```
   The same tool imports a script built elsewhere (`node tools/retarget.mjs <id> <path-to-built.user.js>`), rewriting its URLs, `@match` and reporter to point at this library.
3. Add notes for the new version to `scripts/<id>/changes.json`.
4. `npm test`, then `npm run preview` and open http://127.0.0.1:4180/userscript-library/.
5. Commit and push to `main`. Check that the Actions run is green and the live `script.meta.js` shows the new version.

To add a script, also add a `catalog.json` entry with a permanent lowercase-hyphenated `id`, and a `license.txt`.

## Rules

- Never change a published script's `@name` or `@namespace`. Tampermonkey uses them to identify the script and keep its settings.
- Publish code, notes and licenses only. No API keys, browser storage, FIT files, fixtures or test reports.
- Intervals.icu Weight is retired and not published.
