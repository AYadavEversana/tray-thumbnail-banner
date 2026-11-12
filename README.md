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
- SVG images without a built-in size (such as brand logos stored as data URIs)
  are drawn from the live page, so html2canvas doesn't shrink or crop them.

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
   - **Download all** — each thumbnail as a separate PNG.
   - An individual size — downloads just that one.
   - An individual **top-to-bottom** size (listed under *Top-to-bottom*) —
     the full, expanded ISI for that size as one tall PNG.

Files are saved to your Downloads folder, named by banner size and ISI version,
e.g. `728x90_v.1.0.15.png` (tray) and `728x90_toptobottom_v.1.0.15.png`
(top-to-bottom).

### Top-to-bottom images

**Include top-to-bottom images** is ticked by default. While it's ticked,
**Download all**, **Download all as ZIP** and **All options as ZIP** also save
the full top-to-bottom ISI for each size, next to its tray thumbnail. The
image is cropped to the ISI's real height, not the viewer's 20000px frame, and
keeps the ISI's empty scrollbar gutter. Untick it to download tray thumbnails
only.

### All options (PAN / SUNLIGHT, colour schemes, indications…)

Some viewers have option inputs, such as TAI_LON_HCP's *Pan version* /
*Sunlight version* radios, opening-statement variants or checkboxes. When a
viewer has them, the panel shows an **Options** section with an
**⬇ All options as ZIP** button. It:

1. selects each combination of the radio options (every group is combined, e.g.
   2 header × 2 footer = 4), clicks the viewer's own **Refresh Page**, and waits
   for the trays to re-render;
2. captures every tray size, plus its top-to-bottom image when that option is
   ticked, for that combination;
3. saves one `<isiID>_tray-thumbnails_all-options.zip`, with the option prefixed
   to each file name, e.g. `PAN_160x600_v.1.0.15.png`,
   `SUNLIGHT_160x600_v.1.0.15.png`, `SUNLIGHT_160x600_toptobottom_v.1.0.15.png`;
4. puts the inputs and previews back the way they were.

Checkboxes keep their current state by default. Tick any of them under
**Also vary (on + off)** to capture both states too. They are named `KEY` and
`NO-KEY`, e.g. `AD_BRUSHSTROKE_…` and `AD_NO-BRUSHSTROKE_…`. The button shows
how many combinations will be captured.

Prefixes come from the option keys in the ISI's `config.js`. A leading `show`
and a trailing `colorScheme` are dropped, so `showPan` becomes `PAN` and
`GBWcolorScheme` becomes `GBW`. If two groups share a key (for example header
and footer both have `bog`), the group name is added: `HEADER-BOG_FOOTER-WOB_…`.

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
