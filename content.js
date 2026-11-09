/*
 * Tray Thumbnail Downloader - content script
 *
 * Runs in every frame of a "toptobottomviewer" page.
 *  - Top frame: injects a floating panel with download buttons, sends capture
 *    requests to the tray iframes, and forwards the returned PNGs to the
 *    service worker for downloading.
 *  - Tray iframe: captures its own rendered content with html2canvas (so it
 *    works even under file:// where the parent cannot read the frame), draws
 *    the native scrollbar onto the image, and replies with a PNG data URL.
 *
 * Capturing inside each frame + postMessage is what makes this work from the
 * local file system, where cross-origin frame access is blocked.
 */
(function () {
	if (window.__trayThumbExtLoaded) return;
	window.__trayThumbExtLoaded = true;

	/* ------------------------------------------------------------------ *
	 * Shared: scrollbar drawing (html2canvas does not render scrollbars)
	 * ------------------------------------------------------------------ */
	function getScrollbarStyle(scrollEl) {
		var style = { width: 9, trackColor: "#ffffff", thumbColor: "#037d99", radius: 4, thumbBorder: 0 };
		try {
			var sheets = document.styleSheets;
			for (var i = 0; i < sheets.length; i++) {
				var rules;
				try { rules = sheets[i].cssRules; } catch (err) { continue; }
				if (!rules) continue;
				for (var r = 0; r < rules.length; r++) {
					var sel = rules[r].selectorText || "";
					var st = rules[r].style;
					if (!st || sel.indexOf("-webkit-scrollbar") === -1 || !/isiBody/.test(sel)) continue;

					// Only apply rules that match the current scroll element, so the
					// active color scheme (e.g. the ".WB" class) wins instead of the
					// last rule in the stylesheet.
					var base = sel.split("::-webkit-scrollbar")[0].trim();
					if (base && scrollEl) { try { if (!scrollEl.matches(base)) continue; } catch (e) {} }

					if (/::-webkit-scrollbar$/.test(sel)) {
						if (st.width) style.width = parseInt(st.width, 10) || style.width;
						if (st.backgroundColor) style.trackColor = st.backgroundColor;
					}
					if (/::-webkit-scrollbar-thumb/.test(sel)) {
						if (st.backgroundColor) style.thumbColor = st.backgroundColor;
						if (st.borderRadius) style.radius = parseInt(st.borderRadius, 10) || style.radius;
						var bw = st.borderTopWidth || st.borderWidth || "";
						if (!bw && st.border) { var mm = st.border.match(/(\d+(?:\.\d+)?)px/); if (mm) bw = mm[1] + "px"; }
						if (bw) style.thumbBorder = parseFloat(bw) || 0;
					}
				}
			}
		} catch (err) { /* use defaults */ }
		return style;
	}

	function roundRect(ctx, x, y, w, h, r) {
		r = Math.min(r, w / 2, h / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function findScrollContainer(target) {
		var el = document.getElementById("isiBody");
		if (el && el.scrollHeight > el.clientHeight + 1) return el;
		// Fallback: any scrollable descendant of the capture target.
		var all = target ? target.querySelectorAll("*") : document.querySelectorAll("*");
		for (var i = 0; i < all.length; i++) {
			var e = all[i];
			if (e.scrollHeight > e.clientHeight + 2) {
				var oy = window.getComputedStyle(e).overflowY;
				if (oy === "scroll" || oy === "auto") return e;
			}
		}
		return null;
	}

	function drawScrollbar(canvas, target, cssWidth) {
		var scrollEl = findScrollContainer(target);
		if (!scrollEl) return;

		var sb = getScrollbarStyle(scrollEl);
		var drawScale = canvas.width / cssWidth;
		var targetRect = target.getBoundingClientRect();
		var rect = scrollEl.getBoundingClientRect();

		var barW = sb.width;
		var border = sb.thumbBorder || 0;
		var trackH = scrollEl.clientHeight;
		var xCss = (rect.right - targetRect.left) - barW;
		var yCss = rect.top - targetRect.top;

		var ratio = scrollEl.clientHeight / scrollEl.scrollHeight;
		// Thumb box height, with a sensible minimum so it reads as a pill.
		var thumbHCss = Math.max(trackH * ratio, 20);
		var thumbYCss = yCss + (scrollEl.scrollTop / scrollEl.scrollHeight) * trackH;
		if (thumbYCss + thumbHCss > yCss + trackH) thumbYCss = yCss + trackH - thumbHCss;

		var ctx = canvas.getContext("2d");
		// Track (the scrollbar gutter is reserved, so this does not cover text).
		ctx.fillStyle = sb.trackColor;
		ctx.fillRect(xCss * drawScale, yCss * drawScale, barW * drawScale, trackH * drawScale);

		// Thumb: the CSS thumb has a border the same color as the track, which
		// insets the visible fill. Reproduce that inset so the pill matches.
		var tx = xCss + border;
		var tw = Math.max(barW - 2 * border, 1);
		var ty = thumbYCss + border;
		var th = Math.max(thumbHCss - 2 * border, 1);
		var rad = Math.min(sb.radius, tw / 2, th / 2);
		ctx.fillStyle = sb.thumbColor;
		roundRect(ctx, tx * drawScale, ty * drawScale, tw * drawScale, th * drawScale, rad * drawScale);
		ctx.fill();
	}

	/* ------------------------------------------------------------------ *
	 * Shared: list bullets. ISIs draw list bullets with an element::before
	 * that has an SVG data-URI background image, which html2canvas does not
	 * render. We re-create each one as a real element in the html2canvas
	 * clone, reading the color / position / size / shape from the actual
	 * ::before so it works across every brand (any bullet class).
	 * ------------------------------------------------------------------ */
	function decodeSvgFromBg(bg) {
		if (!bg) return "";
		var m = bg.match(/data:image\/svg\+xml;base64,([^"')]+)/i);
		if (m) { try { return atob(m[1]); } catch (e) { return ""; } }
		m = bg.match(/data:image\/svg\+xml[;,]([^"')]+)/i);
		if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
		return "";
	}

	function parseColor(str) {
		if (!str) return null;
		str = ("" + str).trim();
		var m = str.match(/^#([0-9a-f]{3})$/i);
		if (m) { var h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }; }
		m = str.match(/^#([0-9a-f]{6})$/i);
		if (m) { var h2 = m[1]; return { r: parseInt(h2.slice(0, 2), 16), g: parseInt(h2.slice(2, 4), 16), b: parseInt(h2.slice(4, 6), 16), a: 1 }; }
		m = str.match(/rgba?\(([^)]+)\)/i);
		if (m) { var p = m[1].split(",").map(function (x) { return parseFloat(x); }); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: (p[3] == null ? 1 : p[3]) }; }
		return null;
	}

	function luminance(c) { return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255; }

	// First opaque background color behind an element (ISIs tint #isiBody).
	function bgColorBehind(view, el) {
		var node = el;
		while (node && node.nodeType === 1) {
			var c = parseColor(view.getComputedStyle(node).backgroundColor);
			if (c && c.a > 0) return c;
			node = node.parentElement;
		}
		return { r: 255, g: 255, b: 255, a: 1 };
	}

	function addBulletMarkers(clonedDoc) {
		try {
			var view = clonedDoc.defaultView || window;
			var lis = clonedDoc.getElementsByTagName("li");
			for (var i = 0; i < lis.length; i++) {
				var li = lis[i];
				var cs = view.getComputedStyle(li, "::before");
				var bg = cs ? (cs.backgroundImage || "") : "";
				if (!/data:image\/svg/i.test(bg)) continue; // only the SVG bullets html2canvas misses

				var svg = decodeSvgFromBg(bg);
				var isRing = /fill\s*=\s*["']?none/i.test(svg) || (/stroke\s*=/i.test(svg) && !/fill\s*=\s*["']?#/i.test(svg));
				var cm = svg.match(/fill\s*=\s*["'](#[0-9a-fA-F]{3,6})["']/i) || svg.match(/stroke\s*=\s*["'](#[0-9a-fA-F]{3,6})["']/i);
				var color = cm ? cm[1] : "#000000";

				// Dark-theme ISIs invert the bullet to light via a CSS filter that
				// html2canvas ignores. Match it: on a dark background, a dark bullet
				// becomes white (as the live page renders it).
				var bgc = bgColorBehind(view, li);
				var cc = parseColor(color);
				if (bgc && cc && luminance(bgc) < 0.5 && luminance(cc) < 0.5) color = "#ffffff";

				var boxLeft = parseFloat(cs.left); if (!isFinite(boxLeft)) boxLeft = -10;
				var boxTop = parseFloat(cs.top); if (!isFinite(boxTop)) boxTop = 6;
				var boxW = parseFloat(cs.width); if (!isFinite(boxW)) boxW = 25;
				var boxH = parseFloat(cs.height); if (!isFinite(boxH)) boxH = 25;
				var sz = parseFloat(cs.backgroundSize); if (!isFinite(sz) || sz <= 0) sz = 4;

				// Honor background-position so the dot lands where the SVG actually sits.
				var bp = (cs.backgroundPosition || "0% 0%").split(/\s+/);
				var resolvePos = function (val, box, img) {
					if (val == null) return 0;
					val = ("" + val).trim();
					if (val.slice(-1) === "%") return (box - img) * (parseFloat(val) / 100);
					var n = parseFloat(val);
					return isFinite(n) ? n : 0;
				};
				var left = boxLeft + resolvePos(bp[0], boxW, sz);
				var top = boxTop + resolvePos(bp[1] != null ? bp[1] : bp[0], boxH, sz);

				if (view.getComputedStyle(li).position === "static") li.style.position = "relative";

				var dot = clonedDoc.createElement("span");
				var css = "position:absolute;left:" + left + "px;top:" + top + "px;width:" + sz + "px;height:" + sz + "px;border-radius:50%;box-sizing:border-box;";
				css += isRing ? ("background:transparent;border:1px solid " + color + ";") : ("background:" + color + ";");
				dot.style.cssText = css;
				li.insertBefore(dot, li.firstChild);
			}
		} catch (err) { /* keep image even if bullets fail */ }
	}

	/* ------------------------------------------------------------------ *
	 * Tray iframe: respond to capture requests
	 * ------------------------------------------------------------------ */
	if (window !== window.top) {
		window.addEventListener("message", function (e) {
			var d = e.data;
			if (!d || d.type !== "__trayExtCaptureRequest") return;

			var reply = function (payload) {
				payload.type = "__trayExtCaptureResult";
				payload.id = d.id;
				(e.source || window.parent).postMessage(payload, "*");
			};

			if (typeof html2canvas !== "function") {
				reply({ ok: false, error: "html2canvas not available in frame." });
				return;
			}
			var target = document.getElementById("adHolder") || document.body;
			if (!target) { reply({ ok: false, error: "Nothing to capture in frame." }); return; }

			// Capture the visible tray area (the iframe viewport), not the full
			// banner-width adHolder — e.g. a 728x90 banner shows a 300-wide tray.
			var width = document.documentElement.clientWidth || target.offsetWidth;
			var height = document.documentElement.clientHeight || target.offsetHeight;
			html2canvas(target, {
				backgroundColor: "#ffffff",
				width: width,
				height: height,
				windowWidth: width,
				windowHeight: height,
				scale: 1,
				useCORS: true,
				logging: false,
				onclone: function (clonedDoc) { addBulletMarkers(clonedDoc); }
			}).then(function (canvas) {
				try { drawScrollbar(canvas, target, width); } catch (err) { /* keep image */ }
				reply({ ok: true, dataUrl: canvas.toDataURL("image/png") });
			}).catch(function (err) {
				reply({ ok: false, error: (err && err.message) ? err.message : String(err) });
			});
		});
		return;
	}

	/* ------------------------------------------------------------------ *
	 * Top frame: UI + orchestration
	 * ------------------------------------------------------------------ */
	var pending = {};
	var seq = 0;

	window.addEventListener("message", function (e) {
		var d = e.data;
		if (!d || d.type !== "__trayExtCaptureResult") return;
		var p = pending[d.id];
		if (!p) return;
		delete pending[d.id];
		if (d.ok) p.resolve(d.dataUrl);
		else p.reject(new Error(d.error || "Capture failed in preview frame."));
	});

	function getTrayIframes() {
		return Array.prototype.slice.call(document.querySelectorAll('iframe[src*="actualsize"]'));
	}

	function bannerSizeOf(iframe) {
		var bid = "";
		try { bid = new URL(iframe.getAttribute("src"), location.href).searchParams.get("bid") || ""; } catch (e) {}
		return bid.replace(/^dim/, "");
	}

	function fileNameFor(iframe) {
		var banner = bannerSizeOf(iframe);
		var w = iframe.getAttribute("width") || iframe.offsetWidth;
		var h = iframe.getAttribute("height") || iframe.offsetHeight;
		var ver = versionOf(iframe);
		return (banner || w + "x" + h) + (ver ? "_v." + ver : "");
	}

	function versionOf(iframe) {
		var v = "";
		try { v = new URL(location.href).searchParams.get("isiVer") || ""; } catch (e) {}
		if (!v) {
			try { v = new URL(iframe.getAttribute("src"), location.href).searchParams.get("isiVer") || ""; } catch (e) {}
		}
		return v.replace(/^v\.?/i, "").replace(/[^\w.\-]/g, "");
	}

	function requestCapture(iframe) {
		return new Promise(function (resolve, reject) {
			if (!iframe.contentWindow) { reject(new Error("Preview frame not ready.")); return; }
			var id = "cap_" + (++seq);
			pending[id] = { resolve: resolve, reject: reject };
			try {
				iframe.contentWindow.postMessage({ type: "__trayExtCaptureRequest", id: id }, "*");
			} catch (err) {
				delete pending[id];
				reject(err);
				return;
			}
			setTimeout(function () {
				if (pending[id]) { delete pending[id]; reject(new Error("Timed out. Make sure the preview finished loading.")); }
			}, 15000);
		});
	}

	function saveData(dataUrl, filename) {
		return new Promise(function (resolve) {
			chrome.runtime.sendMessage(
				{ type: "__trayExtDownload", dataUrl: dataUrl, filename: filename },
				function () { resolve(); }
			);
		});
	}

	function saveImage(dataUrl, fileName) {
		return saveData(dataUrl, fileName + ".png");
	}

	function setStatus(text) {
		var s = document.getElementById("__trayExtStatus");
		if (s) s.textContent = text || "";
	}

	function downloadOne(iframe) {
		setStatus("Capturing " + fileNameFor(iframe) + "…");
		return requestCapture(iframe)
			.then(function (dataUrl) { return saveImage(dataUrl, fileNameFor(iframe)); })
			.then(function () { setStatus("Downloaded " + fileNameFor(iframe)); })
			.catch(function (err) {
				setStatus("Error: " + (err && err.message ? err.message : err));
				console.error("[Tray Thumbnail Downloader]", err);
			});
	}

	function downloadAll() {
		var frames = getTrayIframes();
		if (!frames.length) { setStatus("No tray thumbnails found on this page."); return Promise.resolve(); }
		var chain = Promise.resolve();
		frames.forEach(function (ifr) {
			chain = chain.then(function () { return downloadOne(ifr); })
				.then(function () { return new Promise(function (r) { setTimeout(r, 400); }); });
		});
		return chain.then(function () { setStatus("Done. Downloaded " + frames.length + " thumbnail(s)."); });
	}

	/* --------- ZIP (store method, no compression; PNGs are already compressed) --------- */
	var __crcTable = null;
	function crc32(bytes) {
		if (!__crcTable) {
			__crcTable = [];
			for (var n = 0; n < 256; n++) {
				var c = n;
				for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
				__crcTable[n] = c >>> 0;
			}
		}
		var crc = 0xFFFFFFFF;
		for (var i = 0; i < bytes.length; i++) crc = (__crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
		return (crc ^ 0xFFFFFFFF) >>> 0;
	}

	function dataUrlToBytes(dataUrl) {
		var bin = atob(dataUrl.split(",")[1]);
		var bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}

	function bytesToBase64(bytes) {
		var bin = "";
		var chunk = 0x8000;
		for (var i = 0; i < bytes.length; i += chunk) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(bin);
	}

	function buildZip(files) {
		function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
		function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
		function strBytes(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xFF); return a; }

		var chunks = [];
		var central = [];
		var offset = 0;

		files.forEach(function (f) {
			var nameBytes = strBytes(f.name);
			var crc = crc32(f.bytes);
			var size = f.bytes.length;
			var local = [].concat(
				u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
				u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes
			);
			chunks.push(new Uint8Array(local));
			chunks.push(f.bytes);
			central.push([].concat(
				u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
				u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
				u32(0), u32(offset), nameBytes
			));
			offset += local.length + size;
		});

		var centralBytes = [];
		central.forEach(function (c) { centralBytes = centralBytes.concat(c); });
		var end = [].concat(
			u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
			u32(centralBytes.length), u32(offset), u16(0)
		);

		var total = 0;
		chunks.forEach(function (c) { total += c.length; });
		total += centralBytes.length + end.length;

		var out = new Uint8Array(total);
		var pos = 0;
		chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
		out.set(new Uint8Array(centralBytes), pos); pos += centralBytes.length;
		out.set(new Uint8Array(end), pos);
		return out;
	}

	function downloadAllZip() {
		var frames = getTrayIframes();
		if (!frames.length) { setStatus("No tray thumbnails found on this page."); return Promise.resolve(); }

		var files = [];
		var counts = {};
		var chain = Promise.resolve();
		frames.forEach(function (ifr) {
			chain = chain.then(function () {
				setStatus("Capturing " + fileNameFor(ifr) + "…");
				return requestCapture(ifr).then(function (dataUrl) {
					var base = fileNameFor(ifr);
					counts[base] = (counts[base] || 0) + 1;
					var name = (counts[base] === 1 ? base : base + "_" + counts[base]) + ".png";
					files.push({ name: name, bytes: dataUrlToBytes(dataUrl) });
				});
			});
		});

		return chain.then(function () {
			if (!files.length) { setStatus("Nothing captured."); return; }
			setStatus("Building ZIP…");
			var zip = buildZip(files);
			var dataUrl = "data:application/zip;base64," + bytesToBase64(zip);
			return saveData(dataUrl, "tray-thumbnails.zip").then(function () {
				setStatus("Downloaded tray-thumbnails.zip (" + files.length + " images).");
			});
		}).catch(function (err) {
			setStatus("Error: " + (err && err.message ? err.message : err));
			console.error("[Tray Thumbnail Downloader]", err);
		});
	}

	/* ----------------------------- UI ----------------------------- */
	function makeButton(label) {
		var b = document.createElement("button");
		b.textContent = label;
		b.style.cssText =
			"display:block;width:100%;margin:3px 0;padding:6px 10px;border:none;border-radius:4px;" +
			"background:#094548;color:#fff;font:12px/1.2 Arial,sans-serif;cursor:pointer;text-align:left;";
		b.addEventListener("mouseover", function () { b.style.background = "#0c5b5f"; });
		b.addEventListener("mouseout", function () { b.style.background = "#094548"; });
		return b;
	}

	function buildPanel() {
		var frames = getTrayIframes();
		if (!frames.length) return false;

		var existing = document.getElementById("__trayExtBar");
		if (existing) existing.parentNode.removeChild(existing);

		var bar = document.createElement("div");
		bar.id = "__trayExtBar";
		bar.style.cssText =
			"position:fixed;top:12px;right:12px;z-index:2147483647;width:220px;max-height:80vh;overflow:auto;" +
			"background:#ffffff;border:1px solid #094548;border-radius:8px;padding:10px;" +
			"box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:Arial,sans-serif;";

		var title = document.createElement("div");
		title.textContent = "Tray Thumbnails";
		title.style.cssText = "font-weight:700;font-size:13px;color:#094548;margin-bottom:6px;";
		bar.appendChild(title);

		var allBtn = makeButton("⬇ Download all (" + frames.length + ")");
		allBtn.style.background = "#06666b";
		allBtn.addEventListener("click", downloadAll);
		bar.appendChild(allBtn);

		var zipBtn = makeButton("⬇ Download all as ZIP");
		zipBtn.style.background = "#06666b";
		zipBtn.addEventListener("click", downloadAllZip);
		bar.appendChild(zipBtn);

		var sep = document.createElement("div");
		sep.style.cssText = "border-top:1px solid #e0e0e0;margin:6px 0;";
		bar.appendChild(sep);

		frames.forEach(function (ifr) {
			var banner = bannerSizeOf(ifr) || "tray";
			var w = ifr.getAttribute("width") || ifr.offsetWidth;
			var h = ifr.getAttribute("height") || ifr.offsetHeight;
			var btn = makeButton("⬇ " + banner + " (" + w + "x" + h + ")");
			btn.addEventListener("click", function () { downloadOne(ifr); });
			bar.appendChild(btn);
		});

		var status = document.createElement("div");
		status.id = "__trayExtStatus";
		status.style.cssText = "margin-top:8px;font-size:11px;color:#444;min-height:14px;";
		bar.appendChild(status);

		(document.body || document.documentElement).appendChild(bar);
		return true;
	}

	// The viewer builds its tray iframes dynamically, so retry until they exist
	// and keep the panel in sync if the grid changes.
	var tries = 0;
	function tryBuild() {
		if (buildPanel()) return;
		if (++tries < 20) setTimeout(tryBuild, 500);
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", tryBuild);
	} else {
		tryBuild();
	}

	var rebuildTimer = null;
	var observer = new MutationObserver(function () {
		if (rebuildTimer) return;
		rebuildTimer = setTimeout(function () {
			rebuildTimer = null;
			var frames = getTrayIframes();
			var bar = document.getElementById("__trayExtBar");
			if (frames.length && !bar) buildPanel();
		}, 400);
	});
	if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
