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
		var drawBorders = function (b, x, y, w, h) {
			if (!b) return;
			var c = b.color || "#ffffff";
			if (b.l) fillBox(x, y, b.l, h, c);
			if (b.r) fillBox(x + w - b.r, y, b.r, h, c);
			if (b.t) fillBox(x, y, w, b.t, c);
			if (b.b) fillBox(x, y + h - b.b, w, b.b, c);
		};

		// Track (the scrollbar gutter is reserved, so this does not cover text).
		fillBox(xCss, yCss, barW, trackH, sb.trackColor);
		drawBorders(sb.trackB, xCss, yCss, barW, trackH);

		if (sb.thumbB) {
			// Thumb with side borders: fill the box, then paint the borders.
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
	 * Shared: SVG <img> without intrinsic width/height (e.g. brand logos as
	 * viewBox-only data URIs) are mis-sized by html2canvas. Swap each one in
	 * the clone for a canvas drawn from the live, correctly laid-out image.
	 * ------------------------------------------------------------------ */
	function fixSvgImages(clonedDoc) {
		try {
			var live = document.querySelectorAll("img");
			var cloned = clonedDoc.querySelectorAll("img");
			if (live.length !== cloned.length) return;
			for (var i = 0; i < live.length; i++) {
				var img = live[i];
				var src = img.currentSrc || img.src || "";
				if (!/^data:image\/svg\+xml|\.svg(\?|#|$)/i.test(src)) continue;
				if (!img.complete || !img.naturalWidth) continue;
				var w = img.clientWidth, h = img.clientHeight;
				if (!w || !h) continue;
				var scale = 3;
				var c = clonedDoc.createElement("canvas");
				c.width = Math.round(w * scale);
				c.height = Math.round(h * scale);
				c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
				var orig = cloned[i];
				c.className = orig.className;
				if (orig.id) c.id = orig.id;
				var cs = window.getComputedStyle(img);
				c.style.cssText = orig.style.cssText;
				c.style.width = w + "px";
				c.style.height = h + "px";
				c.style.display = cs.display === "inline" ? "inline-block" : cs.display;
				c.style.verticalAlign = cs.verticalAlign;
				orig.parentNode.replaceChild(c, orig);
			}
		} catch (err) { /* keep html2canvas default */ }
	}

	// Top-to-bottom views have no overflow, but an "overflow-y: scroll" ISI
	// still shows an empty, styled scrollbar track.
	function drawEmptyTrack(canvas, target, cssWidth) {
		var el = document.getElementById("isiBody");
		if (!el || window.getComputedStyle(el).overflowY !== "scroll") return;
		if (el.scrollHeight > el.clientHeight + 1) return;
		var st = window.getComputedStyle(el);
		var gutter = el.offsetWidth - el.clientWidth -
			(parseFloat(st.borderLeftWidth) || 0) - (parseFloat(st.borderRightWidth) || 0);
		if (gutter <= 0) return;
		var sb = getScrollbarStyle(el);
		var S = canvas.width / cssWidth;
		var t = target.getBoundingClientRect();
		var r = el.getBoundingClientRect();
		var x = r.right - t.left - (parseFloat(st.borderRightWidth) || 0) - gutter;
		var y = r.top - t.top + (parseFloat(st.borderTopWidth) || 0);
		var ctx = canvas.getContext("2d");
		ctx.fillStyle = sb.trackColor;
		ctx.fillRect(x * S, y * S, gutter * S, el.clientHeight * S);
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
		// Unique per document load, so the top frame can tell when a frame has
		// actually reloaded after "Refresh Page".
		var docToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
		window.addEventListener("message", function (e) {
			var d = e.data;
			if (d && d.type === "__trayExtPing") {
				(e.source || window.parent).postMessage({ type: "__trayExtPong", id: d.id, token: docToken }, "*");
				return;
			}
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
			// Top-to-bottom frames are 20000px tall; crop to the full ISI content.
			var isTb = /[?&]type=toptobottom\b/.test(location.search) || /\/toptobottom\//.test(location.pathname);
			if (isTb) {
				var full = Math.ceil(target.getBoundingClientRect().bottom + window.scrollY);
				if (full > 0) height = Math.min(height, full);
			}
			html2canvas(target, {
				backgroundColor: "#ffffff",
				width: width,
				height: height,
				windowWidth: width,
				windowHeight: height,
				scale: 1,
				useCORS: true,
				logging: false,
				onclone: function (clonedDoc) { fixSvgImages(clonedDoc); addBulletMarkers(clonedDoc); }
			}).then(function (canvas) {
				try { drawScrollbar(canvas, target, width); } catch (err) { /* keep image */ }
				if (isTb) { try { drawEmptyTrack(canvas, target, width); } catch (err) { /* keep image */ } }
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
		if (!d || (d.type !== "__trayExtCaptureResult" && d.type !== "__trayExtPong")) return;
		var p = pending[d.id];
		if (d.type === "__trayExtPong") {
			if (p) { delete pending[d.id]; p.resolve(d.token); }
			return;
		}
		if (!p) return;
		delete pending[d.id];
		if (d.ok) p.resolve(d.dataUrl);
		else p.reject(new Error(d.error || "Capture failed in preview frame."));
	});

	function getTrayIframes() {
		return Array.prototype.slice.call(document.querySelectorAll('iframe[src*="actualsize"]'));
	}

	function getTopToBottomIframes() {
		return Array.prototype.slice.call(document.querySelectorAll('iframe[src*="toptobottom/"]'));
	}

	function isTopToBottom(iframe) {
		return /toptobottom\//.test(iframe.getAttribute("src") || "");
	}

	// kind: "tray" (actual-size thumbnails) or "toptobottom" (full ISI).
	function framesFor(kind) {
		return kind === "toptobottom" ? getTopToBottomIframes() : getTrayIframes();
	}

	function zipNameFor(kind) {
		var isiId = "";
		try { isiId = (new URL(location.href).searchParams.get("isiID") || "").replace(/[^\w.\-]/g, ""); } catch (e) {}
		return (isiId ? isiId + "_" : "") + (kind === "toptobottom" ? "toptobottom" : "tray-thumbnails") + ".zip";
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
		return (banner || w + "x" + h) + (isTopToBottom(iframe) ? "_toptobottom" : "") + (ver ? "_v." + ver : "");
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

	/* ----------------------- My Day activity ----------------------- */
	// Where this viewer sits in the repo: clients/<Client>/<Brand…>/<ISI>/<status>/lib/toptobottomviewer/
	function viewerInfo() {
		var path = "";
		try { path = decodeURIComponent(location.pathname); } catch (e) { path = location.pathname; }
		var q = {};
		try { new URL(location.href).searchParams.forEach(function (v, k) { q[k] = v; }); } catch (e) {}
		var parts = [];
		var m = /\/clients\/(.+?)\/lib\/toptobottomviewer\//.exec(path);
		if (m) parts = m[1].split("/").filter(Boolean);
		else {
			var m2 = /([^\/]+)\/([^\/]+)\/lib\/toptobottomviewer\//.exec(path);
			if (m2) parts = [m2[1], m2[2]];
		}
		var status = parts.length > 1 ? parts[parts.length - 1] : "";
		var folder = parts.length > 1 ? parts[parts.length - 2] : "";
		return {
			key: parts.length ? parts.join("/") : (q.isiID || location.pathname),
			isiID: q.isiID || folder || "ISI",
			client: parts.length > 2 ? parts[0] : "",
			brand: parts.length > 3 ? parts.slice(1, -2).join(" / ") : "",
			status: status,
			version: (q.isiVer || "").replace(/^v\.?/i, ""),
			url: location.href.split("#")[0]
		};
	}

	function logActivity(evt) {
		evt.isi = viewerInfo();
		evt.at = Date.now();
		try { chrome.runtime.sendMessage({ type: "__trayExtActivity", evt: evt }, function () { void chrome.runtime.lastError; }); } catch (e) {}
	}

	function setStatus(text) {
		var s = document.getElementById("__trayExtStatus");
		if (s) s.textContent = text || "";
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

	function errorStatus(err) {
		setStatus("Error: " + (err && err.message ? err.message : err));
		console.error("[Tray Thumbnail Downloader]", err);
	}

	// Capture frames into files[]; prefix (optional) is prepended to each name.
	function captureFrames(frames, files, used, prefix, label) {
		var chain = Promise.resolve();
		frames.forEach(function (ifr) {
			chain = chain.then(function () {
				var base = (prefix ? prefix + "_" : "") + fileNameFor(ifr);
				setStatus((label || "") + "Capturing " + base + "…");
				return requestCapture(ifr).then(function (dataUrl) {
					used[base] = (used[base] || 0) + 1;
					var name = (used[base] === 1 ? base : base + "_" + used[base]) + ".png";
					files.push({ name: name, bytes: dataUrlToBytes(dataUrl) });
				});
			});
		});
		return chain;
	}

	function saveZip(files, zipName, extra) {
		if (!files.length) { setStatus("Nothing captured."); return Promise.resolve(); }
		setStatus("Building ZIP…");
		var dataUrl = "data:application/zip;base64," + bytesToBase64(buildZip(files));
		return saveData(dataUrl, zipName).then(function () {
			setStatus("Downloaded " + zipName + " (" + (extra || "") + files.length + " images).");
			return files.length;
		});
	}

	var busy = false;

	function downloadKind(kind) {
		if (busy) return Promise.resolve();
		if (hasOptions(getOptionModel())) return downloadAllOptions(kind);
		var frames = framesFor(kind);
		if (!frames.length) {
			setStatus(kind === "toptobottom" ? "No top-to-bottom previews found on this page." : "No tray thumbnails found on this page.");
			return Promise.resolve();
		}
		busy = true;
		var files = [];
		return captureFrames(frames, files, {}, "", "")
			.then(function () { return saveZip(files, zipNameFor(kind)); })
			.then(function (n) { if (n) logActivity({ type: "download", kind: kind, options: 0, images: n }); })
			.catch(errorStatus)
			.then(function () { busy = false; });
	}

	/* ------------------------- All options ------------------------- *
	 * Viewers with "showhide" options (radio groups such as PAN/SUNLIGHT
	 * versions, colour schemes, header/footer variants, and checkboxes) are
	 * re-rendered for every combination via the viewer's own "Refresh Page"
	 * button, captured, and saved in one ZIP with the option prefixed to each
	 * filename, e.g. SUNLIGHT_160x600_v.1.0.6.png.
	 */
	function optionIndex(input) {
		var m = /(\d+)$/.exec(input.id || "");
		return m ? parseInt(m[1], 10) : 0;
	}

	function labelFor(input) {
		var cell = input.closest ? input.closest("grid_item") : null;
		var prev = cell ? cell.previousElementSibling : null;
		return prev ? (prev.textContent || "").trim() : (input.id || "option");
	}

	function getOptionInputs() {
		var grid = document.getElementById("inputGridContainer");
		if (!grid) return [];
		return Array.prototype.slice.call(
			grid.querySelectorAll('input[type="radio"][id^="radio"], input[type="checkbox"][id^="checkbox"]')
		).sort(function (a, b) { return optionIndex(a) - optionIndex(b); });
	}

	function getOptionModel() {
		var inputs = getOptionInputs();
		var groups = [];
		var byName = {};
		var checkboxes = [];
		inputs.forEach(function (inp) {
			if (inp.type === "radio") {
				var g = byName[inp.name];
				if (!g) { g = byName[inp.name] = { name: inp.name, radios: [] }; groups.push(g); }
				g.radios.push(inp);
			} else {
				checkboxes.push(inp);
			}
		});
		return { inputs: inputs, groups: groups, checkboxes: checkboxes };
	}

	function hasOptions(model) {
		return model.checkboxes.length > 0 || model.groups.some(function (g) { return g.radios.length > 1; });
	}

	function buildVariants(model, varyBoxes) {
		var variants = [[]];
		model.groups.forEach(function (g) {
			var next = [];
			variants.forEach(function (v) {
				g.radios.forEach(function (r) { next.push(v.concat([{ input: r, checked: true, group: g }])); });
			});
			variants = next;
		});
		varyBoxes.forEach(function (cb) {
			var next = [];
			variants.forEach(function (v) {
				next.push(v.concat([{ input: cb, checked: true, vary: true }]));
				next.push(v.concat([{ input: cb, checked: false, vary: true }]));
			});
			variants = next;
		});
		return variants;
	}

	// Map option inputs to their config keys by reading the query string the
	// viewer writes into the tray iframe src (same order as the inputs).
	function readOptionKeys(model) {
		var map = {};
		var ifr = getTrayIframes()[0];
		if (!ifr) return map;
		var params = [];
		try {
			new URL(ifr.getAttribute("src"), location.href).searchParams.forEach(function (val, name) {
				if (name === "bid" || name === "btn" || name === "type") return;
				if (/^inject~/.test(val)) return;
				params.push(name);
			});
		} catch (e) { return map; }
		if (params.length !== model.inputs.length) return map;
		model.inputs.forEach(function (inp, i) {
			var name = params[i];
			var tilde = name.indexOf("~");
			map[inp.id] = tilde >= 0 ? name.slice(tilde + 1) : name;
		});
		return map;
	}

	function tokenize(text) {
		return String(text || "")
			.replace(/^show(?=[A-Z])/, "")
			.replace(/colou?rscheme$/i, "")
			.replace(/\s+version$/i, "")
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	function optionToken(input, keys) {
		return tokenize(keys[input.id] || labelFor(input)) || tokenize(input.id);
	}

	function prefixFor(variant, model, keys) {
		// Disambiguate radio tokens that repeat across groups (e.g. header/footer "BOG").
		var seen = {};
		var clash = {};
		model.groups.forEach(function (g) {
			if (g.radios.length < 2) return;
			g.radios.forEach(function (r) {
				var t = optionToken(r, keys);
				if (seen[t] && seen[t] !== g.name) { clash[g.name] = true; clash[seen[t]] = true; }
				seen[t] = seen[t] || g.name;
			});
		});
		var parts = [];
		variant.forEach(function (s) {
			var t = optionToken(s.input, keys);
			if (s.group) {
				if (s.group.radios.length < 2) return;
				parts.push(clash[s.group.name] ? tokenize(s.group.name) + "-" + t : t);
			} else if (s.vary) {
				parts.push(s.checked ? t : "NO-" + t);
			}
		});
		return parts.join("_");
	}

	function pingFrame(iframe, ms) {
		return new Promise(function (resolve) {
			if (!iframe.contentWindow) { resolve(null); return; }
			var id = "ping_" + (++seq);
			pending[id] = { resolve: resolve, reject: function () { resolve(null); } };
			try { iframe.contentWindow.postMessage({ type: "__trayExtPing", id: id }, "*"); } catch (e) {}
			setTimeout(function () { if (pending[id]) { delete pending[id]; resolve(null); } }, ms || 500);
		});
	}

	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	function frameTokens(kind) {
		return Promise.all(framesFor(kind).map(function (f) { return pingFrame(f, 800); }));
	}

	function waitForReload(kind, oldTokens, timeoutMs) {
		var deadline = Date.now() + (timeoutMs || 25000);
		function poll() {
			return frameTokens(kind).then(function (tokens) {
				var ready = tokens.length > 0 && tokens.every(function (t, i) { return t && t !== oldTokens[i]; });
				if (ready) return true;
				if (Date.now() > deadline) return false;
				return sleep(300).then(poll);
			});
		}
		return poll();
	}

	function findRefreshButton() {
		var grid = document.getElementById("inputGridContainer") || document;
		return Array.prototype.slice.call(grid.querySelectorAll('input[type="submit"], input[type="button"], button'))
			.filter(function (b) { return /refresh/i.test(b.value || b.textContent || ""); })[0] || null;
	}

	function applyVariant(variant, kind) {
		variant.forEach(function (s) { s.input.checked = s.checked; });
		var btn = findRefreshButton();
		if (!btn) return Promise.reject(new Error("Couldn't find the viewer's \"Refresh Page\" button."));
		return frameTokens(kind).then(function (oldTokens) {
			btn.click();
			return waitForReload(kind, oldTokens);
		}).then(function (ok) {
			if (!ok) console.warn("[Tray Thumbnail Downloader] Frames did not confirm reload in time; capturing anyway.");
			return sleep(2500); // let fonts/GSAP finish laying out the ISI
		});
	}

	// Checkboxes the user ticked under "Also vary (on + off)".
	var varyBoxes = [];

	function downloadAllOptions(kind) {
		var model = getOptionModel();
		var boxes = varyBoxes.filter(function (cb) { return cb.isConnected; })
			.sort(function (a, b) { return optionIndex(a) - optionIndex(b); });
		var variants = buildVariants(model, boxes);
		var frameCount = framesFor(kind).length;
		if (!frameCount) {
			setStatus(kind === "toptobottom" ? "No top-to-bottom previews found on this page." : "No tray thumbnails found on this page.");
			return Promise.resolve();
		}
		if (variants.length * frameCount > 120 &&
			!window.confirm(variants.length + " option combinations × " + frameCount + " sizes = " +
				(variants.length * frameCount) + " images. Continue?")) return Promise.resolve();

		busy = true;
		var original = model.inputs.map(function (inp) { return inp.checked; });
		var originalSrcs = Array.prototype.slice.call(document.querySelectorAll("iframe")).map(function (f) {
			return { el: f, src: f.getAttribute("src") };
		});
		var files = [];
		var used = {};
		var keys = {};
		var chain = Promise.resolve();

		variants.forEach(function (variant, vi) {
			var label = "Option " + (vi + 1) + "/" + variants.length + ": ";
			chain = chain.then(function () {
				setStatus(label + "rendering…");
				return applyVariant(variant, kind);
			}).then(function () {
				if (!Object.keys(keys).length) keys = readOptionKeys(model);
				var prefix = prefixFor(variant, model, keys) || ("OPTION-" + (vi + 1));
				return captureFrames(framesFor(kind), files, used, prefix, label);
			});
		});

		function restore() {
			model.inputs.forEach(function (inp, i) { inp.checked = original[i]; });
			originalSrcs.forEach(function (o) {
				if (o.el.isConnected && o.src && o.el.getAttribute("src") !== o.src) o.el.setAttribute("src", o.src);
			});
		}

		return chain.then(function () {
			restore();
			return saveZip(files, zipNameFor(kind), variants.length + " options, ").then(function (n) {
				if (n) logActivity({ type: "download", kind: kind, options: variants.length, images: n });
			});
		}).catch(function (err) {
			restore();
			errorStatus(err);
		}).then(function () { busy = false; });
	}

	function buildOptionsSection(bar) {
		var model = getOptionModel();
		if (!hasOptions(model)) return;

		var box = document.createElement("div");
		box.id = "__trayExtOptions";
		box.style.cssText = "border-top:1px solid #e0e0e0;margin:6px 0 0;padding-top:6px;";

		var head = document.createElement("div");
		head.textContent = "Options";
		head.style.cssText = "font-weight:700;font-size:12px;color:#094548;margin-bottom:3px;";
		box.appendChild(head);

		var desc = document.createElement("div");
		desc.style.cssText = "font-size:11px;color:#555;margin-bottom:4px;line-height:1.35;";
		var multi = model.groups.filter(function (g) { return g.radios.length > 1; });
		desc.textContent = multi.length
			? multi.map(function (g) {
				return g.radios.map(function (r) { return labelFor(r); }).join(" / ");
			}).join(" × ")
			: "Checkbox options only.";
		box.appendChild(desc);

		varyBoxes = [];
		var count = document.createElement("div");
		count.style.cssText = "font-size:11px;color:#094548;margin-top:4px;font-weight:700;";
		function updateLabel() {
			var n = buildVariants(model, varyBoxes).length;
			count.textContent = "Each download includes " + n + " option" + (n === 1 ? "" : "s") + ".";
		}
		if (model.checkboxes.length) {
			var hint = document.createElement("div");
			hint.textContent = "Also vary (on + off):";
			hint.style.cssText = "font-size:11px;color:#444;margin:4px 0 2px;";
			box.appendChild(hint);
			model.checkboxes.forEach(function (cb) {
				var row = document.createElement("label");
				row.style.cssText = "display:flex;align-items:flex-start;gap:4px;font-size:11px;color:#333;margin:2px 0;cursor:pointer;";
				var t = document.createElement("input");
				t.type = "checkbox";
				t.style.margin = "1px 0 0";
				t.addEventListener("change", function () {
					var i = varyBoxes.indexOf(cb);
					if (t.checked && i < 0) varyBoxes.push(cb);
					if (!t.checked && i >= 0) varyBoxes.splice(i, 1);
					updateLabel();
				});
				var span = document.createElement("span");
				span.textContent = labelFor(cb);
				row.appendChild(t);
				row.appendChild(span);
				box.appendChild(row);
			});
		}

		updateLabel();
		box.appendChild(count);
		bar.appendChild(box);
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

	function makeFavStar() {
		var star = document.createElement("button");
		star.id = "__trayExtFav";
		star.style.cssText = "border:none;background:none;padding:0 2px;font-size:17px;line-height:17px;cursor:pointer;color:#b9c4c4;";
		var info = viewerInfo();
		var on = false;
		function paint() {
			star.textContent = on ? "★" : "☆";
			star.style.color = on ? "#e0a800" : "#9aa8a8";
			star.title = on ? "Remove from My Day favourites" : "Add to My Day favourites";
		}
		paint();
		try {
			chrome.storage.local.get("favorites", function (d) {
				on = !!(d && d.favorites && d.favorites[info.key]);
				paint();
			});
		} catch (e) { star.style.display = "none"; }
		star.addEventListener("click", function () {
			try {
				chrome.storage.local.get("favorites", function (d) {
					var favs = (d && d.favorites) || {};
					if (favs[info.key]) delete favs[info.key];
					else favs[info.key] = Object.assign({}, info, { addedAt: Date.now() });
					on = !!favs[info.key];
					paint();
					chrome.storage.local.set({ favorites: favs });
				});
			} catch (e) { setStatus("Reload this page after updating the extension."); }
		});
		return star;
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
		title.style.cssText = "display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:13px;color:#094548;margin-bottom:6px;";
		title.appendChild(document.createTextNode("Tray Thumbnails"));
		title.appendChild(makeFavStar());
		bar.appendChild(title);

		var trayBtn = makeButton("⬇ Download all tray (" + frames.length + ")");
		trayBtn.addEventListener("click", function () { downloadKind("tray"); });
		bar.appendChild(trayBtn);

		var tbCount = getTopToBottomIframes().length;
		if (tbCount) {
			var tbBtn = makeButton("⬇ Download all top-to-bottom (" + tbCount + ")");
			tbBtn.addEventListener("click", function () { downloadKind("toptobottom"); });
			bar.appendChild(tbBtn);
		}

		buildOptionsSection(bar);

		var mdBtn = makeButton("📅 My Day – switcher, recent, changes, summary");
		mdBtn.style.marginTop = "8px";
		mdBtn.style.background = "#fff";
		mdBtn.style.color = "#094548";
		mdBtn.style.border = "1px solid #094548";
		mdBtn.addEventListener("mouseover", function () { mdBtn.style.background = "#e6f0f0"; });
		mdBtn.addEventListener("mouseout", function () { mdBtn.style.background = "#fff"; });
		mdBtn.addEventListener("click", function () {
			try { chrome.runtime.sendMessage({ type: "__trayExtOpenMyDay" }); }
			catch (e) { setStatus("Reload this page after updating the extension."); }
		});
		bar.appendChild(mdBtn);

		var status = document.createElement("div");
		status.id = "__trayExtStatus";
		status.style.cssText = "margin-top:8px;font-size:11px;color:#444;min-height:14px;";
		bar.appendChild(status);

		(document.body || document.documentElement).appendChild(bar);
		return true;
	}

	// The viewer builds its tray iframes dynamically, so retry until they exist
	// and keep the panel in sync if the grid changes.
	logActivity({ type: "view" });

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
			else if (bar && !busy && !document.getElementById("__trayExtOptions") &&
				hasOptions(getOptionModel())) buildPanel();
		}, 400);
	});
	if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
