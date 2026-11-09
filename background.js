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
