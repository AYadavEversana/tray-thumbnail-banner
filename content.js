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
		var style = { width: 9, trackColor: "#ffffff", thumbColor: "#037d99", radius: 4, thumbBorder: 0,
			trackB: null, thumbB: null };
		var sideBorders = function (st) {
			var o = { l: 0, r: 0, t: 0, b: 0, color: "" };
			var any = false;
			[["l", "Left"], ["r", "Right"], ["t", "Top"], ["b", "Bottom"]].forEach(function (p) {
				var sty = st["border" + p[1] + "Style"];
				var w = parseFloat(st["border" + p[1] + "Width"]);
				if (sty && sty !== "none" && w > 0) { o[p[0]] = w; any = true; if (!o.color) o.color = st["border" + p[1] + "Color"] || ""; }
			});
			return any ? o : null;
		};
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
						var tb = sideBorders(st);
						if (tb) style.trackB = tb;
					}
					if (/::-webkit-scrollbar-thumb/.test(sel)) {
						if (st.backgroundColor) style.thumbColor = st.backgroundColor;
						if (st.borderRadius) style.radius = parseInt(st.borderRadius, 10) || style.radius;
						var bw = st.borderTopWidth || st.borderWidth || "";
						if (!bw && st.border) { var mm = st.border.match(/(\d+(?:\.\d+)?)px/); if (mm) bw = mm[1] + "px"; }
						if (bw) style.thumbBorder = parseFloat(bw) || 0;
						var thb = sideBorders(st);
						if (thb && !thb.t && !thb.b) style.thumbB = thb;
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
		var S = drawScale;
		var fillBox = function (x, y, w, h, color) {
			ctx.fillStyle = color;
			ctx.fillRect(x * S, y * S, w * S, h * S);
		};
		// Chrome paints the element background under its borders, so draw the
		// fill over the whole box and then the borders on top.
		var drawBorders = function (bd, x, y, w, h) {
			if (!bd) return;
			var c = bd.color || "#ffffff";
			if (bd.l) fillBox(x, y, bd.l, h, c);
			if (bd.r) fillBox(x + w - bd.r, y, bd.r, h, c);
			if (bd.t) fillBox(x, y, w, bd.t, c);
			if (bd.b) fillBox(x, y + h - bd.b, w, bd.b, c);
		};

		// Track (the scrollbar gutter is reserved, so this does not cover text).
		fillBox(xCss, yCss, barW, trackH, sb.trackColor);
		drawBorders(sb.trackB, xCss, yCss, barW, trackH);

		if (sb.thumbB) {
			var rad0 = Math.min(sb.radius, barW / 2, thumbHCss / 2);
			if (rad0 > 0) {
				ctx.fillStyle = sb.thumbColor;
				roundRect(ctx, xCss * S, thumbYCss * S, barW * S, thumbHCss * S, rad0 * S);
				ctx.fill();
			} else {
				fillBox(xCss, thumbYCss, barW, thumbHCss, sb.thumbColor);
			}
			drawBorders(sb.thumbB, xCss, thumbYCss, barW, thumbHCss);
			return;
		}

		// Thumb: the CSS thumb has a border the same color as the track, which
		// insets the visible fill. Reproduce that inset so the pill matches.
		var tx = xCss + border;
		var tw = Math.max(barW - 2 * border, 1);
		var ty = thumbYCss + border;
		var th = Math.max(thumbHCss - 2 * border, 1);
		var rad = Math.min(sb.radius, tw / 2, th / 2);
		ctx.fillStyle = sb.thumbColor;
		roundRect(ctx, tx * S, ty * S, tw * S, th * S, rad * S);
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
		// Passive recorder for QA: when the ISI autoscroll starts/stops and where it ends.
		var scrollLog = { first: null, last: null, count: 0, top: 0, max: 0, touched: false };
		document.addEventListener("scroll", function (ev) {
			var t = ev.target;
			if (!t || t === document) t = document.scrollingElement || document.documentElement;
			var now = performance.now();
			if (scrollLog.first === null) scrollLog.first = now;
			scrollLog.last = now;
			scrollLog.count++;
			scrollLog.top = t.scrollTop;
			scrollLog.max = t.scrollHeight - t.clientHeight;
		}, true);
		["wheel", "mousedown", "touchstart", "keydown"].forEach(function (n) {
			document.addEventListener(n, function () { scrollLog.touched = true; }, true);
		});

		window.addEventListener("message", function (e) {
			var d = e.data;
			if (!d || d.type !== "__trayExtInspectRequest") return;
			var reply = function (payload) {
				payload.type = "__trayExtInspectResult";
				payload.id = d.id;
				(e.source || window.parent).postMessage(payload, "*");
			};
			try {
				var body = document.getElementById("isiBody") || document.body;
				var links = Array.prototype.slice.call(document.querySelectorAll("a")).map(function (a) {
					return {
						href: a.getAttribute("href") || "",
						text: (a.textContent || "").replace(/\s+/g, " ").trim(),
						target: a.getAttribute("target") || "",
						rel: a.getAttribute("rel") || ""
					};
				});
				var sc = body.scrollHeight > body.clientHeight ? body : (document.scrollingElement || document.documentElement);
				reply({
					ok: true,
					text: (body.innerText || body.textContent || "").replace(/\r/g, ""),
					links: links,
					viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
					scrollHeight: sc.scrollHeight,
					clientHeight: sc.clientHeight,
					scroll: {
						first: scrollLog.first, last: scrollLog.last, count: scrollLog.count,
						top: scrollLog.top, max: scrollLog.max, touched: scrollLog.touched,
						now: performance.now(), curTop: sc.scrollTop
					}
				});
			} catch (err) {
				reply({ ok: false, error: String(err && err.message || err) });
			}
		});

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
		if (!d || d.type !== "__trayExtInspectResult") return;
		var p = pending[d.id];
		if (!p) return;
		delete pending[d.id];
		if (d.ok) p.resolve(d);
		else p.reject(new Error(d.error || "Inspect failed in preview frame."));
	});

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

	function copyOne(iframe) {
		var name = fileNameFor(iframe);
		setStatus("Capturing " + name + "…");
		return requestCapture(iframe)
			.then(function (dataUrl) {
				var blob = new Blob([dataUrlToBytes(dataUrl)], { type: "image/png" });
				return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			})
			.then(function () { setStatus("Copied " + name + " to clipboard"); })
			.catch(function (err) {
				setStatus("Copy failed: " + (err && err.message ? err.message : err));
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

	/* ------------------------- Review & QA ------------------------- */
	function requestInspect(iframe) {
		return new Promise(function (resolve, reject) {
			if (!iframe.contentWindow) { reject(new Error("Preview frame not ready.")); return; }
			var id = "ins_" + (++seq);
			pending[id] = { resolve: resolve, reject: reject };
			try {
				iframe.contentWindow.postMessage({ type: "__trayExtInspectRequest", id: id }, "*");
			} catch (err) { delete pending[id]; reject(err); return; }
			setTimeout(function () {
				if (pending[id]) { delete pending[id]; reject(new Error("Timed out reading preview frame.")); }
			}, 8000);
		});
	}

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
		});
	}

	function textLines(t) {
		return String(t || "").split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); })
			.filter(function (l) { return l; });
	}

	function lineDiff(a, b) {
		var n = a.length, m = b.length, i, j;
		var dp = [];
		for (i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
		for (i = n - 1; i >= 0; i--) {
			for (j = m - 1; j >= 0; j--) {
				dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		var out = [];
		i = 0; j = 0;
		while (i < n && j < m) {
			if (a[i] === b[j]) { out.push({ t: "same", s: a[i] }); i++; j++; }
			else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", s: a[i++] }); }
			else { out.push({ t: "add", s: b[j++] }); }
		}
		while (i < n) out.push({ t: "del", s: a[i++] });
		while (j < m) out.push({ t: "add", s: b[j++] });
		return out;
	}

	function checkLink(url) {
		return new Promise(function (resolve) {
			chrome.runtime.sendMessage({ type: "__trayExtCheckLink", url: url }, function (res) {
				if (chrome.runtime.lastError || !res) resolve({ ok: false, error: "No response" });
				else resolve(res);
			});
		});
	}

	function pageParam(name) {
		try { return new URL(location.href).searchParams.get(name) || ""; } catch (e) { return ""; }
	}

	function showModal(title, bodyHtml, reportName) {
		var old = document.getElementById("__trayExtModal");
		if (old) old.parentNode.removeChild(old);
		var css =
			"#__trayExtModal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;}" +
			"#__trayExtModal .box{background:#fff;width:min(960px,92vw);max-height:88vh;display:flex;flex-direction:column;border-radius:8px;overflow:hidden;}" +
			"#__trayExtModal .hd{display:flex;align-items:center;padding:10px 14px;background:#094548;color:#fff;font-weight:700;font-size:14px;}" +
			"#__trayExtModal .hd span{flex:1;}" +
			"#__trayExtModal .hd button{margin-left:8px;padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-size:12px;}" +
			"#__trayExtModal .bd{padding:14px;overflow:auto;font-size:12px;color:#222;}" +
			"#__trayExtModal h3{margin:14px 0 6px;font-size:13px;color:#094548;}" +
			"#__trayExtModal table{border-collapse:collapse;width:100%;margin-bottom:8px;}" +
			"#__trayExtModal th,#__trayExtModal td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top;}" +
			"#__trayExtModal th{background:#f2f5f5;}" +
			"#__trayExtModal .pass{color:#0a7a2f;font-weight:700;}#__trayExtModal .warn{color:#b26a00;font-weight:700;}#__trayExtModal .fail{color:#c0152f;font-weight:700;}" +
			"#__trayExtModal .add{background:#e3f6e8;}#__trayExtModal .del{background:#fde7ea;text-decoration:line-through;}" +
			"#__trayExtModal .ln{padding:1px 6px;white-space:pre-wrap;}";
		var wrap = document.createElement("div");
		wrap.id = "__trayExtModal";
		wrap.innerHTML = "<style>" + css + "</style><div class='box'><div class='hd'><span>" + esc(title) +
			"</span><button id='__trayExtDl'>Download report</button><button id='__trayExtX'>Close</button></div><div class='bd'>" +
			bodyHtml + "</div></div>";
		(document.body || document.documentElement).appendChild(wrap);
		wrap.querySelector("#__trayExtX").addEventListener("click", function () { wrap.parentNode.removeChild(wrap); });
		wrap.addEventListener("click", function (e) { if (e.target === wrap) wrap.parentNode.removeChild(wrap); });
		wrap.querySelector("#__trayExtDl").addEventListener("click", function () {
			var html = "<!doctype html><meta charset='utf-8'><title>" + esc(title) + "</title><style>" + css.replace(/#__trayExtModal /g, "") +
				"body{font-family:Arial,sans-serif;font-size:12px;padding:16px}</style><h2>" + esc(title) + "</h2>" + bodyHtml;
			saveData("data:text/html;charset=utf-8," + encodeURIComponent(html), reportName);
		});
	}

	function badge(level, text) { return "<span class='" + level + "'>" + esc(text) + "</span>"; }

	function runQA() {
		var frames = getTrayIframes();
		if (!frames.length) { setStatus("No tray thumbnails found on this page."); return Promise.resolve(); }
		setStatus("Running QA review…");
		var infos = [];
		var chain = Promise.resolve();
		frames.forEach(function (ifr) {
			chain = chain.then(function () {
				return requestInspect(ifr).then(function (d) { infos.push({ ifr: ifr, d: d }); })
					.catch(function (err) { infos.push({ ifr: ifr, err: err.message }); });
			});
		});
		return chain.then(function () {
			// Consensus ISI text = the most common normalized text across sizes.
			var counts = {};
			infos.forEach(function (x) {
				if (!x.d) return;
				x.norm = textLines(x.d.text).join("\n");
				counts[x.norm] = (counts[x.norm] || 0) + 1;
			});
			var best = "", bestN = 0;
			Object.keys(counts).forEach(function (k) { if (counts[k] > bestN) { best = k; bestN = counts[k]; } });

			var seen = {}, rows = "", fails = 0, warns = 0;
			var allLinks = {};
			infos.forEach(function (x) {
				var size = bannerSizeOf(x.ifr) || "tray";
				var ver = versionOf(x.ifr);
				var checks = [];
				var add = function (level, text) { checks.push(badge(level, text)); if (level === "fail") fails++; if (level === "warn") warns++; };
				if (x.err || !x.d) {
					add("fail", "Could not read frame: " + (x.err || "unknown"));
				} else {
					var d = x.d;
					if (seen[size]) add("warn", "Duplicate size");
					seen[size] = true;
					if (!ver) add("warn", "No version in URL");
					if (d.viewport.w < 10 || d.viewport.h < 10) add("fail", "Tray has no visible size");
					if (x.norm.length < 20) add("fail", "Blank / missing ISI text");
					else if (x.norm !== best) add("fail", "ISI text differs from other sizes");
					else add("pass", "Text matches");
					var s = d.scroll;
					if (s.touched) add("warn", "Page was touched; timing may be off");
					if (d.scrollHeight <= d.clientHeight + 1) add("warn", "ISI is not scrollable");
					else if (!s.count) add("warn", "No autoscroll seen (reload page to measure)");
					else {
						var delay = (s.first / 1000).toFixed(1), dur = ((s.last - s.first) / 1000).toFixed(1);
						var atEnd = s.top >= s.max - 2;
						add(atEnd ? "pass" : "warn", "Starts " + delay + "s, scrolls " + dur + "s, " +
							(atEnd ? "reached bottom" : "stopped at " + Math.round(s.top) + "/" + Math.round(s.max) + "px (stop point)"));
					}
					d.links.forEach(function (l) { (allLinks[l.href] = allLinks[l.href] || []).push({ size: size, l: l }); });
				}
				rows += "<tr><td>" + esc(size) + "</td><td>" + esc(ver || "—") + "</td><td>" + (x.d ? x.norm.split("\n").length : "—") +
					"</td><td>" + checks.join("<br>") + "</td></tr>";
			});

			var hrefs = Object.keys(allLinks);
			var linkRows = [];
			var netQueue = [];
			hrefs.forEach(function (h) {
				var first = allLinks[h][0].l;
				var issues = [];
				if (!h || h === "#") issues.push(["fail", "Empty link"]);
				else if (/^javascript:/i.test(h)) issues.push(["warn", "javascript: link"]);
				else if (/^http:\/\//i.test(h)) issues.push(["warn", "Not HTTPS"]);
				if (first.target !== "_blank" && /^https?:/i.test(h)) issues.push(["warn", "Does not open in new tab"]);
				var entry = { href: h, text: first.text, issues: issues, sizes: allLinks[h].map(function (z) { return z.size; }) };
				linkRows.push(entry);
				if (/^https?:\/\//i.test(h)) netQueue.push(entry);
			});

			var idx = 0;
			function worker() {
				if (idx >= netQueue.length) return Promise.resolve();
				var entry = netQueue[idx++];
				setStatus("Checking links " + idx + "/" + netQueue.length + "…");
				return checkLink(entry.href).then(function (r) {
					if (r.ok) entry.issues.push(["pass", "HTTP " + r.status]);
					else entry.issues.push(["fail", r.status ? "HTTP " + r.status : "Unreachable (" + (r.error || "error") + ")"]);
				}).then(worker);
			}
			return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
				var linkHtml = linkRows.map(function (e) {
					if (!e.issues.length) e.issues.push(["pass", "OK"]);
					e.issues.forEach(function (i) { if (i[0] === "fail") fails++; else if (i[0] === "warn") warns++; });
					return "<tr><td>" + esc(e.text || "(no text)") + "</td><td style='word-break:break-all'>" + esc(e.href) + "</td><td>" +
						e.issues.map(function (i) { return badge(i[0], i[1]); }).join("<br>") + "</td></tr>";
				}).join("");

				var vers = {};
				infos.forEach(function (x) { var v = versionOf(x.ifr); if (v) vers[v] = true; });
				var id = pageParam("isiID");
				var summary = "<p><b>ISI:</b> " + esc(id || "—") + " &nbsp; <b>Version:</b> " + esc(Object.keys(vers).join(", ") || "—") +
					" &nbsp; <b>Sizes:</b> " + infos.length + " &nbsp; <b>Date:</b> " + esc(new Date().toLocaleString()) + "</p><p>" +
					(fails ? badge("fail", fails + " failure(s)") : badge("pass", "No failures")) + " &nbsp; " +
					(warns ? badge("warn", warns + " warning(s)") : badge("pass", "No warnings")) + "</p>";
				showModal("QA review — " + (id || "ISI"),
					summary + "<h3>Tray checks</h3><table><tr><th>Size</th><th>Version</th><th>Text lines</th><th>Result</th></tr>" + rows + "</table>" +
					"<h3>Links (" + linkRows.length + " unique)</h3>" +
					(linkRows.length ? "<table><tr><th>Text</th><th>URL</th><th>Result</th></tr>" + linkHtml + "</table>" : "<p>No links found.</p>"),
					"QA-report_" + (id || "ISI") + ".html");
				setStatus("QA review done: " + fails + " failure(s), " + warns + " warning(s).");
			});
		}).catch(function (err) {
			setStatus("QA error: " + (err && err.message ? err.message : err));
			console.error("[Tray Thumbnail Downloader]", err);
		});
	}

	function currentIsiText() {
		var frames = getTrayIframes();
		if (!frames.length) return Promise.reject(new Error("No tray frames found."));
		return requestInspect(frames[0]).then(function (d) {
			return { lines: textLines(d.text), version: versionOf(frames[0]) };
		});
	}

	function saveSnapshot() {
		setStatus("Reading ISI text…");
		return currentIsiText().then(function (cur) {
			var id = pageParam("isiID") || "ISI";
			var snap = { id: id, version: cur.version, savedAt: new Date().toISOString(), lines: cur.lines };
			var name = "isi-text_" + id + (cur.version ? "_v." + cur.version : "") + ".json";
			return saveData("data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(snap, null, 1)), name)
				.then(function () { setStatus("Saved snapshot " + name); });
		}).catch(function (err) { setStatus("Error: " + (err && err.message ? err.message : err)); });
	}

	function compareSnapshot() {
		var input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,.txt";
		input.addEventListener("change", function () {
			var file = input.files && input.files[0];
			if (!file) return;
			var reader = new FileReader();
			reader.onload = function () {
				var old;
				try {
					var raw = String(reader.result);
					var parsed = null;
					try { parsed = JSON.parse(raw); } catch (e) { /* plain text file */ }
					old = parsed && parsed.lines ? parsed : { id: "", version: "", lines: textLines(raw) };
				} catch (err) { setStatus("Could not read snapshot."); return; }
				setStatus("Comparing…");
				currentIsiText().then(function (cur) {
					var diff = lineDiff(old.lines, cur.lines);
					var added = diff.filter(function (x) { return x.t === "add"; }).length;
					var removed = diff.filter(function (x) { return x.t === "del"; }).length;
					var body = "<p><b>Old:</b> " + esc(old.id || file.name) + " " + esc(old.version ? "v." + old.version : "") +
						" &nbsp; <b>New (this page):</b> " + esc(pageParam("isiID")) + " " + esc(cur.version ? "v." + cur.version : "") + "</p><p>" +
						(added || removed ? badge("warn", added + " added, " + removed + " removed line(s)") : badge("pass", "No text changes")) + "</p>" +
						diff.map(function (x) {
							return "<div class='ln " + (x.t === "same" ? "" : x.t) + "'>" + (x.t === "add" ? "+ " : x.t === "del" ? "− " : "  ") + esc(x.s) + "</div>";
						}).join("");
					showModal("ISI text comparison", body, "ISI-text-diff_" + (pageParam("isiID") || "ISI") + ".html");
					setStatus("Compared: " + added + " added, " + removed + " removed.");
				}).catch(function (err) { setStatus("Error: " + (err && err.message ? err.message : err)); });
			};
			reader.readAsText(file);
		});
		input.click();
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
			var copyBtn = makeButton("📋");
			copyBtn.title = "Copy " + banner + " to clipboard";
			copyBtn.style.cssText += "width:auto;margin:3px 0 3px 4px;";
			copyBtn.addEventListener("click", function () { copyOne(ifr); });
			var row = document.createElement("div");
			row.style.cssText = "display:flex;align-items:center;";
			btn.style.flex = "1";
			row.appendChild(btn);
			row.appendChild(copyBtn);
			bar.appendChild(row);
		});

		var qaTitle = document.createElement("div");
		qaTitle.textContent = "Review & QA";
		qaTitle.style.cssText = "font-weight:700;font-size:12px;color:#094548;margin:2px 0 4px;";
		bar.appendChild(qaTitle);
		[
			["🔍 Run QA review", runQA],
			["📝 Save ISI text snapshot", saveSnapshot],
			["🆚 Compare text with snapshot…", compareSnapshot]
		].forEach(function (b) {
			var btn = makeButton(b[0]);
			btn.addEventListener("click", b[1]);
			bar.appendChild(btn);
		});

		var sep2 = document.createElement("div");
		sep2.style.cssText = "border-top:1px solid #e0e0e0;margin:6px 0;";
		bar.appendChild(sep2);

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
