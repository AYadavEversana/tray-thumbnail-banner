# Tray Thumbnail Downloader (Chrome extension)

Downloads the **tray-size ISI thumbnails** shown on TheBrief `toptobottomviewer`
preview pages as PNG images — including the ISI scrollbar, which a normal
screenshot tool or `html2canvas` capture would miss.

It works on **every brand/client** that uses the standard `toptobottomviewer`
page, with no changes to the client files. Install it once and use it anywhere.

## How it works

- The capture runs **inside each tray preview frame** and the image is sent back
  to the page via `postMessage`. This is what lets it work from the local file
  system (`file://`), where a page is otherwise blocked from reading its own
  cross-origin preview frames.
- `html2canvas` is bundled (in `vendor/`), so no internet connection is required
  for the capture itself.
- The native ISI scrollbar is drawn onto the image afterward (html2canvas does
  not render native scrollbars), matching the real `::-webkit-scrollbar` colors.
- ISI list bullets (an `li::before` SVG background image that html2canvas skips)
  are re-created as real dots in the capture, reading each bullet's color,
  position, size and fill/outline style from the page so it matches any brand.

## Install (one time, per machine)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `tray-thumbnail-banner` folder.
4. **For local files (`file://` URLs):** click **Details** on the extension and
   enable **Allow access to file URLs**. (Not needed for `http(s)://` pages.)

## Usage

1. Open any `.../toptobottomviewer/index.htm` preview page.
2. A **Tray Thumbnails** panel appears at the top-right of the page.
3. Wait until the tray previews have finished loading/animating.
4. Choose one of:
   - **Download all as ZIP** — one `tray-thumbnails.zip` with every thumbnail.
   - **📋 button next to each size** — copies that thumbnail to the clipboard, ready to paste into email, Slack or a doc.
   - **Download all** — each thumbnail as a separate PNG.
   - An individual size — downloads just that one.

### Review & QA

- **🔍 Run QA review** — opens a report (with a *Download report* HTML button) covering, per size:
  version present, blank/missing ISI text, text differing between sizes, no visible size,
  duplicate sizes, and ISI autoscroll timing (start delay, duration, whether it reached the
  bottom or stopped at a stop point). It also lists every unique link with static checks
  (empty, `javascript:`, non-HTTPS, not opening in a new tab) and a live HTTP status check.
  Autoscroll timing is recorded from page load, so reload the page if the scroll already
  finished before the extension attached, and don't touch the tray while it runs.
- **📝 Save ISI text snapshot** — saves `isi-text_<ID>_v.<ver>.json` with the current ISI text.
- **🆚 Compare text with snapshot…** — pick a saved snapshot (or a `.txt` file) and see a
  line-by-line added/removed diff against the ISI text on the current page. Save a snapshot
  from the old version, open the new version, then compare.

The link status check needs the `<all_urls>` host permission so the extension can request
the ISI's external links.

Files are saved to your Downloads folder, named by size, e.g.
`728x90_v.1.3.1.png`, `300x250_v.1.3.1.png`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3). Injects only on `*toptobottomviewer*` URLs. |
| `content.js` | Builds the panel (top frame) and captures each tray (preview frames). |
| `background.js` | Service worker; saves the PNGs via the `downloads` API. |
| `vendor/html2canvas.min.js` | Bundled renderer (v1.4.1). |

## Notes / troubleshooting

- **Panel doesn't appear:** make sure the URL path contains `toptobottomviewer`.
  Reload the page after installing the extension.
- **Nothing downloads from a local file:** enable *Allow access to file URLs*
  (see install step 4).
- **A thumbnail fails to capture:** wait until the preview has fully rendered,
  then try again. The status line at the bottom of the panel shows progress and
  any error details.
