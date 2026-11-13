// Service worker: performs the actual file download using the downloads API.
// Receives PNG data URLs from the content script and saves them.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.type !== "__trayExtDownload") return;
	chrome.downloads.download(
		{
			url: msg.dataUrl,
			filename: msg.filename,
			saveAs: false,
			conflictAction: "uniquify"
		},
		(downloadId) => {
			if (chrome.runtime.lastError) {
				sendResponse({ ok: false, error: chrome.runtime.lastError.message });
			} else {
				sendResponse({ ok: true, downloadId: downloadId });
			}
		}
	);
	return true; // keep the message channel open for the async response
});

/* ---------------------------- My Day ---------------------------- */
const RECENT_MAX = 10;
const ACTIVITY_DAYS = 45;

function dayKey(ts) {
	const d = new Date(ts);
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function applyActivity(evt) {
	const isi = evt.isi || {};
	if (!isi.key) return;
	const { activity = {}, recent = [] } = await chrome.storage.local.get(["activity", "recent"]);

	const day = dayKey(evt.at);
	const today = (activity[day] = activity[day] || { isis: {} });
	const e = (today.isis[isi.key] = today.isis[isi.key] || {
		isiID: isi.isiID, client: isi.client, brand: isi.brand, status: isi.status,
		versions: [], views: 0, downloads: {}, firstAt: evt.at
	});
	e.lastAt = evt.at;
	e.url = isi.url;
	if (isi.version && e.versions.indexOf(isi.version) < 0) e.versions.push(isi.version);
	if (evt.type === "view") e.views++;
	if (evt.type === "download") {
		const dl = (e.downloads[evt.kind] = e.downloads[evt.kind] || { count: 0, options: 0, images: 0 });
		dl.count++;
		dl.options = Math.max(dl.options, evt.options || 0);
		dl.images += evt.images || 0;
	}

	const cutoff = dayKey(Date.now() - ACTIVITY_DAYS * 86400000);
	Object.keys(activity).forEach((k) => { if (k < cutoff) delete activity[k]; });

	const prev = recent.find((r) => r.key === isi.key);
	const entry = Object.assign({}, prev || {}, {
		key: isi.key, isiID: isi.isiID, client: isi.client, brand: isi.brand, status: isi.status,
		version: isi.version || (prev && prev.version) || "", url: isi.url, at: evt.at
	});
	const nextRecent = [entry].concat(recent.filter((r) => r.key !== isi.key)).slice(0, RECENT_MAX);

	await chrome.storage.local.set({ activity, recent: nextRecent });
}

// Serialize writes so events from several viewer tabs don't overwrite each other.
let activityQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.type !== "__trayExtActivity") return;
	activityQueue = activityQueue
		.then(() => applyActivity(msg.evt || {}))
		.catch((err) => console.error("[Tray Thumbnail Downloader] activity", err));
	activityQueue.then(() => sendResponse({ ok: true }));
	return true;
});

// Toolbar icon (or the panel's My Day button) opens or focuses the My Day page.
async function openMyDay() {
	const url = chrome.runtime.getURL("myday.html");
	try {
		const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
		const open = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(url) && c.tabId >= 0);
		if (open) {
			const tab = await chrome.tabs.update(open.tabId, { active: true });
			if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
			return;
		}
	} catch (e) { /* fall through and open a new tab */ }
	await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(() => { openMyDay(); });
chrome.runtime.onMessage.addListener((msg) => {
	if (msg && msg.type === "__trayExtOpenMyDay") openMyDay();
});
