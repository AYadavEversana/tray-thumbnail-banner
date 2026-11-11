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
