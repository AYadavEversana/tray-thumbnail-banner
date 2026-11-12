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

// Link checker for the QA review: HEAD first, falling back to GET.
async function probe(url, method, signal) {
	return fetch(url, { method: method, redirect: "follow", signal: signal, cache: "no-store" });
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.type !== "__trayExtCheckLink") return;
	(async () => {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), 8000);
		try {
			let res = await probe(msg.url, "HEAD", ctl.signal);
			if (res.status === 403 || res.status === 405 || res.status === 501) res = await probe(msg.url, "GET", ctl.signal);
			sendResponse({ ok: res.status < 400, status: res.status });
		} catch (err) {
			sendResponse({ ok: false, error: err && err.name === "AbortError" ? "timeout" : "network error" });
		} finally {
			clearTimeout(timer);
		}
	})();
	return true;
});

// Screenshot of the visible tab for the rendering self-check. Chrome allows
// only ~2 captures per second, so calls are spaced out.
let lastShot = 0;
let shotQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.type !== "__trayExtScreenshot") return;
	shotQueue = shotQueue.then(async () => {
		const wait = 600 - (Date.now() - lastShot);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		try {
			const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
			sendResponse({ ok: true, dataUrl: dataUrl });
		} catch (err) {
			sendResponse({ ok: false, error: (err && err.message) || String(err) });
		} finally {
			lastShot = Date.now();
		}
	});
	return true;
});

// Opens the all-brands audit page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || msg.type !== "__trayExtOpenAudit") return;
	const url = chrome.runtime.getURL("audit.html") + "?base=" + encodeURIComponent(msg.base || "");
	chrome.tabs.create({ url: url, index: sender.tab ? sender.tab.index + 1 : undefined }, () => sendResponse({ ok: true }));
	return true;
});
