# Tray Thumbnail Downloader (Chrome extension)

Downloads the **tray-size ISI thumbnails** shown on TheBrief `toptobottomviewer`
preview pages as PNG images — including the ISI scrollbar, which a normal
screenshot tool or `html2canvas` capture would miss.

It works on **every brand/client** that uses the standard `toptobottomviewer`
page, with no changes to the client files. Install it once and use it anywhere.

The toolbar icon also opens **[My Day](#my-day-daily-dashboard)**. It offers a
quick ISI switcher, favourites, a pending queue, your recent ISIs, what changed in the repo since yesterday,
and a copy-ready daily summary.

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
4. Click one of the two buttons:
   - **⬇ Download all tray**: every tray-size thumbnail in one
     `<isiID>_tray-thumbnails.zip`.
   - **⬇ Download all top-to-bottom**: the full, expanded ISI for every size
     in one `<isiID>_toptobottom.zip`.

Files inside each ZIP are named by banner size and ISI version, e.g.
`728x90_v.1.0.15.png` (tray) and `728x90_toptobottom_v.1.0.15.png`
(top-to-bottom). Top-to-bottom images are cropped to the ISI's real height, not
the viewer's 20000px frame, and keep the ISI's empty scrollbar gutter.

### Viewers with options (PAN / SUNLIGHT, colour schemes, indications…)

Some viewers have option inputs, such as TAI_LON_HCP's *Pan version* /
*Sunlight version* radios, opening-statement variants or checkboxes. On those
viewers the panel shows an **Options** section, and both buttons download
**every option** automatically:

1. each combination of the radio options is selected (every group is combined,
   e.g. 2 header × 2 footer = 4), the viewer's own **Refresh Page** is clicked,
   and the previews are given time to re-render;
2. every size is captured for that combination;
3. the option is prefixed to each file name, e.g. `PAN_160x600_v.1.0.15.png`
   and `SUNLIGHT_160x600_v.1.0.15.png` in the tray ZIP, or
   `SUNLIGHT_160x600_toptobottom_v.1.0.15.png` in the top-to-bottom ZIP;
4. the inputs and previews are put back the way they were.

Checkboxes keep their current state by default. Tick any of them under
**Also vary (on + off)** to capture both states too. They are named `KEY` and
`NO-KEY`, e.g. `AD_BRUSHSTROKE_…` and `AD_NO-BRUSHSTROKE_…`. The panel shows
how many combinations each download will include.

Prefixes come from the option keys in the ISI's `config.js`. A leading `show`
and a trailing `colorScheme` are dropped, so `showPan` becomes `PAN` and
`GBWcolorScheme` becomes `GBW`. If two groups share a key (for example header
and footer both have `bog`), the group name is added: `HEADER-BOG_FOOTER-WOB_…`.

## My Day (daily dashboard)

Click the extension's **toolbar icon**, or the **📅 My Day** button at the
bottom of the viewer panel, to open **My Day**. (To see the toolbar icon, pin
the extension from Chrome's puzzle-piece menu.) It has these cards:

- **Quick ISI switcher:** type part of an ISI ID, client or brand (for example
  `lon` or `taiho`). Use ↑/↓ to move and **Enter** to open that ISI's
  top-to-bottom viewer in a new tab. Press `/` anywhere to jump to the search box.
- **★ Favourites:** click ☆ next to any ISI in My Day, or the ☆ in the
  viewer panel's title, to pin it. Favourites stay in this card, rank higher in
  the switcher, and sync live between the panel and My Day.
- **Pending queue:** every ISI that has a `pending` folder (after you connect
  the repo folder), with the longest-waiting first. Each row shows:
  - how long it has waited (amber at 3+ days, red at 7+);
  - the approved version it will replace, "no approved yet", or a red warning
    when the pending version is the same as or older than approved (likely
    leftover or already published);
  - the history notes for the pending version.

  Pending history has no approval date, so the wait is counted from when My Day
  first saw that pending version. On the first scan this is the newest file time
  in the folder, so it can be off after a fresh `git clone`/`pull`. A new
  pending version resets the timer.
- **Recent ISIs:** the last 10 viewers you opened, newest first. Click one to
  reopen it.
- **What changed since yesterday:** click **Connect repo folder…** and select
  your local `Banners_TheBrief_ISIs` folder. The extension only reads it. All
  ~90 ISIs are indexed in under a second. The card lists ISIs where:
  - files in the `approved`/`pending` folder were modified since the start of
    yesterday;
  - the version (`isiText.js`) differs from the last scan taken before today;
  - the ISI is new since that scan;
  - the latest `history.htm` approval date is yesterday or today.

  When an ISI was bumped or approved, its latest history notes are shown too.
  Use **Rescan** to refresh.
- **Daily summary:** a plain-text recap for any day. It lists the ISIs you
  viewed or downloaded, with times, versions, options and ZIP types. You can
  optionally add the repo files changed that day. Click **Copy summary** to
  paste it into Teams, email or a timesheet.

**Viewer base URL** (at the bottom) is where links open, for example
`http://localhost:8767/` or `file:///Users/you/Banners_TheBrief_ISIs/`. It is
detected automatically from viewers you've opened; change it and click
**Save** if needed.

Limitations:
- Activity is stored only in this browser (`chrome.storage.local`, last 45
  days). Nothing is sent anywhere.
- "Changed" uses file modification times, so a `git pull` or checkout also
  counts as a change.
- Version bumps are tracked from the day after the first scan.
- Chrome may ask you to re-allow folder access once per browser session.
- Opening `file://` links requires *Allow access to file URLs* (install step 4).

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3). Injects only on `*toptobottomviewer*` URLs. |
| `content.js` | Builds the panel (top frame), captures each tray (preview frames), and logs viewer activity for My Day. |
| `background.js` | Service worker. Saves downloads, stores My Day activity, and opens My Day from the toolbar icon. |
| `myday.html` / `myday.css` / `myday.js` | The My Day dashboard (switcher, favourites, pending queue, recent ISIs, changes, daily summary). |
| `vendor/html2canvas.min.js` | Bundled renderer (v1.4.1). |

## Notes / troubleshooting

- **Panel doesn't appear:** make sure the URL path contains `toptobottomviewer`.
  Reload the page after installing the extension.
- **Nothing downloads from a local file:** enable *Allow access to file URLs*
  (see install step 4).
- **A thumbnail fails to capture:** wait until the preview has fully rendered,
  then try again. The status line at the bottom of the panel shows progress and
  any error details.
