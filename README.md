# Sparx Bookwork Logger

A Firefox extension for Sparx Maths. It records the code of every question you
answer (the dark tab at the top, e.g. **1A**) together with the answer you
submitted, and when a **Bookwork check** appears it looks up the answer you
gave for that code and outlines the matching option in green.

```
question 1A  ->  you type 9.725 and 9.735  ->  Sparx says "Correct!"
                 saved as  { code: "1A", answer: "9.725 | 9.735", result: "correct" }

Bookwork check "Bookwork 1A"  ->  the card showing 9.725 <= n < 9.735 gets a green outline
```

## Install (temporary, for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Pick `extension/manifest.json` from this repository.
4. Open Sparx Maths. A small dark status bar appears bottom-left of the page
   (`Sparx Logger · Q 1A · draft: ... · 12 saved`).

Temporary add-ons are removed when Firefox closes. To keep it installed
permanently either:

- use **Firefox Developer Edition** or **Nightly**, set
  `xpinstall.signatures.required` to `false` in `about:config`, run
  `./build.sh` and open the produced `sparx-bookwork-logger.xpi` in Firefox; or
- submit the `.xpi` to <https://addons.mozilla.org/developers/> for signing
  (free, "unlisted" is fine) and install the signed file.

## What it does

| Screen | Behaviour |
|---|---|
| Question (`1A`, `1B`, ...) | Detects the active code, reads the answer boxes while you type, remembers option clicks for multiple-choice questions. |
| "Submit answer" clicked | Creates a log entry with result `submitted`. |
| "Correct!" banner | Marks that entry `correct`. If no entry exists yet one is created. |
| "Incorrect" banner | Deletes the entry, so wrong answers are never kept. |
| Bookwork check | Reads the code from the blue `Bookwork 1C` button, finds the logged answer, outlines the matching option (green = exact match, amber = partial) and shows a banner at the top with the answer text so you can compare by eye if the highlight fails. |

Everything is stored locally in the browser (`browser.storage.local`); nothing
is sent anywhere. The toolbar popup shows the log, lets you export it as JSON,
delete entries or clear it, and toggles the on-page status bar.

## How answers are read

Sparx renders the whole answer row inside a `data-stack="answer-content"`
container: typed numbers, symbol slots filled from a picker, and fixed text such
as the variable name. The extension reads that container in order, so an
inequality question is logged as `18.15 ≤ f < 18.25`, exactly as it later
appears in the bookwork check. Multi-part answers are joined with ` | `.

For "select answer" / "select answer(s)" questions the chosen card(s) carry a
`_CardContentSelected_` class; their texts are logged as the answer
(e.g. `7 | 13`). The active question tab is the link with a `_Selected_` class.
Class names have hashed suffixes, so they are matched by prefix, with the older
text/colour heuristics kept as fallbacks.

## When something is not detected

If a screen is not recognised by the selectors above, the extension falls back
to finding things by text and colour. If it shows
`no question detected`, captures no answer, or fails to highlight an option:

1. Open the toolbar popup (or the on-page status bar) and click
   **Copy page HTML** while the problem screen is showing.
2. Paste the copied HTML into the chat. It contains the page markup with
   scripts and styles removed. Note that it will include your name as shown on
   the page.

That HTML is what is needed to tighten the selectors in `extension/content.js`
(`findActiveCode`, `captureAnswer`, `findOptions`).

## Files

- `extension/manifest.json` - extension manifest (Manifest V2, Firefox).
- `extension/content.js` - all page logic (question logging + bookwork highlight).
- `extension/popup.html`, `extension/popup.js` - toolbar popup.
- `build.sh` - zips the extension into an `.xpi`.
