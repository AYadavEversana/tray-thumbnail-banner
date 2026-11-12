/*
 * Rendering checks shared by the self-check and the all-brands audit.
 * Loaded before content.js in every frame; exposes `TrayChecks`.
 *
 * - styleAudit(): runs inside a tray frame and lists styling that the
 *   downloader cannot reproduce exactly (scrollbar, bullets, fonts, effects).
 * - geometry(): runs inside a tray frame and reports where the scrollbar and
 *   each bullet sit, so the pixel comparison can check those areas closely.
 * - compare(): runs in the top frame and compares the real screenshot of a
 *   tray with the downloaded image, region by region.
 */
var TrayChecks = (function () {
	"use strict";

	// Per-pixel difference (0-255, max channel) that counts as different.
	// Content is compared after a light blur (text antialiasing / sub-pixel
	// placement); the scrollbar is flat colour, so it is compared raw and
	// much more strictly.
	var PIXEL_THRESHOLD = 30;
	var SCROLLBAR_THRESHOLD = 12;
	var LIMITS = {
		scrollbarWarn: 0.03, scrollbarFail: 0.08,
		bulletFail: 0.2,
		overallWarn: 0.04, overallFail: 0.12
	};

	function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

	function scrollbarRules(scrollEl) {
		var out = [];
		var sheets = document.styleSheets;
		for (var i = 0; i < sheets.length; i++) {
			var rules;
			try { rules = sheets[i].cssRules; } catch (e) { continue; }
			if (!rules) continue;
			for (var r = 0; r < rules.length; r++) {
				var sel = rules[r].selectorText || "";
				if (sel.indexOf("-webkit-scrollbar") === -1) continue;
				var base = sel.split("::-webkit-scrollbar")[0].trim();
				if (base && scrollEl) { try { if (!scrollEl.matches(base)) continue; } catch (e) { continue; } }
				out.push({ sel: sel, part: (sel.match(/::-webkit-scrollbar(-[a-z-]+)?/) || [""])[0], style: rules[r].style });
			}
		}
		return out;
	}

	function realScrollbarWidth(el) {
		var cs = getComputedStyle(el);
		var r = el.getBoundingClientRect();
		return Math.max(0, Math.round(r.width - el.clientWidth - num(cs.borderLeftWidth, 0) - num(cs.borderRightWidth, 0)));
	}

	// Approximate box of every visible list bullet, in frame viewport pixels.
	function bulletBoxes(root) {
		var boxes = [];
		var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
		var lis = (root || document).getElementsByTagName("li");
		for (var i = 0; i < lis.length && boxes.length < 60; i++) {
			var li = lis[i];
			var lr = li.getBoundingClientRect();
			if (lr.bottom < 0 || lr.top > vh || lr.height === 0) continue;
			var cs = getComputedStyle(li, "::before");
			var content = cs ? cs.content : "none";
			var box = null, kind = "";
			if (content && content !== "none" && content !== "normal") {
				var w = num(cs.width, 0), h = num(cs.height, 0);
				var left = num(cs.left, 0), top = num(cs.top, 0);
				var bg = cs.backgroundImage || "";
				if (/data:image\/svg/i.test(bg)) {
					var sz = num(cs.backgroundSize, 4) || 4;
					var bp = (cs.backgroundPosition || "0% 0%").split(/\s+/);
					var res = function (v, b) {
						v = String(v == null ? "0" : v);
						return v.slice(-1) === "%" ? (b - sz) * (parseFloat(v) / 100) : num(v, 0);
					};
					box = { x: lr.left + left + res(bp[0], w || 25), y: lr.top + top + res(bp[1] != null ? bp[1] : bp[0], h || 25), w: sz, h: sz };
					kind = "svg";
				} else if (cs.position === "absolute" && w > 0 && h > 0) {
					box = { x: lr.left + left, y: lr.top + top, w: w, h: h };
					kind = "before";
				} else {
					box = { x: lr.left - 16, y: lr.top, w: 16, h: Math.min(num(getComputedStyle(li).lineHeight, 18), 22) };
					kind = "before-text";
				}
			} else if (getComputedStyle(li).display === "list-item" && getComputedStyle(li).listStyleType !== "none") {
				box = { x: lr.left - 16, y: lr.top, w: 14, h: Math.min(num(getComputedStyle(li).lineHeight, 18), 22) };
				kind = "marker";
			}
			if (!box) continue;
			if (box.x + box.w < 0 || box.x > vw || box.y + box.h < 0 || box.y > vh) continue;
			// Skip bullets mostly off-screen or hidden under something else (e.g. a
			// footer bar).
			var hx = box.x + box.w / 2, hy = box.y + box.h / 2;
			if (hx < 0 || hx >= vw || hy < 0 || hy >= vh) continue;
			var hit = document.elementFromPoint(hx, hy);
			if (hit && hit !== li && !li.contains(hit) && !hit.contains(li)) continue;
			boxes.push({ x: Math.floor(box.x) - 2, y: Math.floor(box.y) - 2, w: Math.ceil(box.w) + 4, h: Math.ceil(box.h) + 4, kind: kind });
		}
		return boxes;
	}

	function geometry(scrollEl) {
		var g = {
			w: document.documentElement.clientWidth,
			h: document.documentElement.clientHeight,
			scrollbar: null,
			bullets: []
		};
		if (scrollEl) {
			var r = scrollEl.getBoundingClientRect();
			var cs = getComputedStyle(scrollEl);
			var sw = realScrollbarWidth(scrollEl);
			if (sw > 0) {
				g.scrollbar = {
					x: Math.round(r.right - num(cs.borderRightWidth, 0) - sw),
					y: Math.round(r.top + num(cs.borderTopWidth, 0)),
					w: sw,
					h: scrollEl.clientHeight
				};
			}
		}
		g.bullets = bulletBoxes(document.getElementById("isiBody") || document.body);
		return g;
	}

	function issue(list, level, area, text) { list.push({ level: level, area: area, text: text }); }

	function styleAudit(scrollEl, cssBarWidth) {
		var issues = [];
		try {
			// Scrollbar
			if (scrollEl) {
				var cs = getComputedStyle(scrollEl);
				var rules = scrollbarRules(scrollEl);
				var parts = {};
				rules.forEach(function (r) { parts[r.part] = (parts[r.part] || []).concat(r); });
				var real = realScrollbarWidth(scrollEl);
				if ((cs.scrollbarColor && cs.scrollbarColor !== "auto") || (cs.scrollbarWidth && cs.scrollbarWidth !== "auto")) {
					issue(issues, "fail", "Scrollbar", "Uses scrollbar-color / scrollbar-width, which override ::-webkit-scrollbar; the downloader draws from ::-webkit-scrollbar rules.");
				}
				if (!parts["::-webkit-scrollbar"] && !parts["::-webkit-scrollbar-thumb"]) {
					issue(issues, real > 0 ? "warn" : "fail", "Scrollbar",
						"No custom ::-webkit-scrollbar CSS; the native scrollbar " + (real > 0 ? "is drawn with default colors." : "is an overlay, but the downloader draws a default bar."));
				}
				if (real > 0 && cssBarWidth && Math.abs(real - cssBarWidth) > 1) {
					issue(issues, "warn", "Scrollbar", "Real scrollbar is " + real + "px wide but the CSS width read is " + cssBarWidth + "px.");
				}
				["::-webkit-scrollbar-track", "::-webkit-scrollbar-track-piece", "::-webkit-scrollbar-button", "::-webkit-scrollbar-corner"].forEach(function (p) {
					(parts[p] || []).forEach(function (r) {
						var s = r.style;
						if (s.backgroundColor || s.backgroundImage || s.borderWidth || s.borderLeftWidth || s.boxShadow || s.height || s.width) {
							issue(issues, "warn", "Scrollbar", r.part + " is styled separately (" + r.sel + "); it is not reproduced.");
						}
					});
				});
				rules.forEach(function (r) {
					var s = r.style;
					if (/:hover|:active/.test(r.sel)) return;
					if (s.backgroundImage && s.backgroundImage !== "none") issue(issues, "warn", "Scrollbar", "Gradient/image background on " + r.part + " is drawn as a flat color.");
					if (s.boxShadow && s.boxShadow !== "none") issue(issues, "warn", "Scrollbar", "box-shadow on " + r.part + " is not reproduced.");
				});
				(parts["::-webkit-scrollbar-thumb"] || []).forEach(function (r) {
					var s = r.style;
					var sides = ["Top", "Right", "Bottom", "Left"].filter(function (d) {
						return s["border" + d + "Style"] && s["border" + d + "Style"] !== "none" && num(s["border" + d + "Width"], 0) > 0;
					});
					if (sides.length === 4) {
						var track = (parts["::-webkit-scrollbar"] || []).map(function (x) { return x.style.backgroundColor; }).filter(Boolean).pop() || "";
						var bc = s.borderTopColor || "";
						if (track && bc && bc.replace(/\s/g, "") !== track.replace(/\s/g, "")) {
							issue(issues, "warn", "Scrollbar", "Thumb border color (" + bc + ") differs from the track (" + track + "); drawn as an inset.");
						}
					}
				});
			}

			// Bullets
			var lis = document.getElementsByTagName("li");
			var seen = {};
			for (var i = 0; i < lis.length; i++) {
				var li = lis[i];
				var b = getComputedStyle(li, "::before");
				var lcs = getComputedStyle(li);
				var bg = b ? b.backgroundImage || "" : "";
				var key;
				if (/data:image\/svg/i.test(bg)) {
					var m = bg.match(/data:image\/svg\+xml;base64,([^"')]+)/i);
					var svg = "";
					try { svg = m ? atob(m[1]) : decodeURIComponent((bg.match(/data:image\/svg\+xml[;,]([^"')]+)/i) || ["", ""])[1]); } catch (e) { svg = ""; }
					if (svg && !/<circle|<ellipse/i.test(svg)) {
						key = "shape";
						if (!seen[key]) issue(issues, "warn", "Bullets", "SVG bullet is not a circle; the downloader draws it as a dot.");
						seen[key] = true;
					}
					if ((b.filter && b.filter !== "none") || (lcs.filter && lcs.filter !== "none")) {
						key = "filter";
						if (!seen[key]) issue(issues, "warn", "Bullets", "Bullet uses a CSS filter; its color is approximated.");
						seen[key] = true;
					}
				} else if (bg && bg !== "none" && !seen.img) {
					seen.img = true;
					issue(issues, "warn", "Bullets", "Bullet uses an image background (" + bg.slice(0, 60) + "…); check it in the download.");
				}
				if (lcs.listStyleImage && lcs.listStyleImage !== "none" && !seen.lsi) {
					seen.lsi = true;
					issue(issues, "warn", "Bullets", "list-style-image bullets may not render in the download.");
				}
				if (lcs.display === "list-item" && lcs.listStyleType !== "none" && !seen.marker) {
					var mk = getComputedStyle(li, "::marker");
					if (mk && mk.color && mk.color !== lcs.color) {
						seen.marker = true;
						issue(issues, "warn", "Bullets", "::marker has its own color; the download uses the text color.");
					}
				}
			}

			// Fonts
			if (document.fonts && document.fonts.forEach) {
				var failed = {};
				document.fonts.forEach(function (f) { if (f.status === "error") failed[f.family] = true; });
				Object.keys(failed).forEach(function (fam) { issue(issues, "fail", "Fonts", "Web font failed to load: " + fam + "."); });
			}

			// Effects html2canvas does not support
			var root = document.getElementById("adHolder") || document.body;
			var els = root ? root.getElementsByTagName("*") : [];
			var fx = {};
			for (var j = 0; j < els.length && j < 3000; j++) {
				var s = getComputedStyle(els[j]);
				if (s.mixBlendMode && s.mixBlendMode !== "normal") fx["mix-blend-mode"] = true;
				if (s.clipPath && s.clipPath !== "none") fx["clip-path"] = true;
				if (s.backdropFilter && s.backdropFilter !== "none") fx["backdrop-filter"] = true;
				if (s.webkitBackgroundClip === "text" || s.backgroundClip === "text") fx["background-clip:text"] = true;
				if (s.filter && s.filter !== "none" && els[j].tagName !== "IMG") fx["filter"] = true;
				if (s.writingMode && s.writingMode.indexOf("vertical") === 0) fx["vertical writing-mode"] = true;
			}
			Object.keys(fx).forEach(function (k) { issue(issues, "warn", "Effects", k + " is used and may not render in the download."); });
		} catch (err) {
			issue(issues, "warn", "Audit", "Style audit error: " + (err && err.message || err));
		}
		return issues;
	}

	/* ------------------------- pixel comparison ------------------------- */

	// Smallest max-channel difference between A(x,y) and B within 1px, so
	// sub-pixel shifts and antialiasing do not count as differences.
	function nearDiff(A, B, w, h, x, y) {
		var i = (y * w + x) * 4;
		var best = 255;
		for (var dy = -1; dy <= 1; dy++) {
			var yy = y + dy; if (yy < 0 || yy >= h) continue;
			for (var dx = -1; dx <= 1; dx++) {
				var xx = x + dx; if (xx < 0 || xx >= w) continue;
				var j = (yy * w + xx) * 4;
				var d = Math.max(Math.abs(A[i] - B[j]), Math.abs(A[i + 1] - B[j + 1]), Math.abs(A[i + 2] - B[j + 2]));
				if (d < best) { best = d; if (best === 0) return 0; }
			}
		}
		return best;
	}

	// 3x3 box blur so sub-pixel placement / antialiasing differences cancel out.
	function blur(src, w, h) {
		var out = new Uint8ClampedArray(src.length);
		for (var y = 0; y < h; y++) {
			for (var x = 0; x < w; x++) {
				var r = 0, g = 0, b = 0, n = 0;
				for (var dy = -1; dy <= 1; dy++) {
					var yy = y + dy; if (yy < 0 || yy >= h) continue;
					for (var dx = -1; dx <= 1; dx++) {
						var xx = x + dx; if (xx < 0 || xx >= w) continue;
						var j = (yy * w + xx) * 4;
						r += src[j]; g += src[j + 1]; b += src[j + 2]; n++;
					}
				}
				var o = (y * w + x) * 4;
				out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
			}
		}
		return out;
	}

	// Distance from A's pixel to the per-channel [min,max] range of B's 3x3
	// neighbourhood: a sub-pixel blend of neighbouring colours scores 0. Used
	// one way only (real vs download), since the real screenshot is the one
	// that gets blended when the iframe sits on a fractional position.
	function rangeDiff(A, B, w, h, x, y) {
		var i = (y * w + x) * 4, worst = 0;
		for (var c = 0; c < 3; c++) {
			var lo = 255, hi = 0;
			for (var dy = -1; dy <= 1; dy++) {
				var yy = y + dy; if (yy < 0 || yy >= h) continue;
				for (var dx = -1; dx <= 1; dx++) {
					var xx = x + dx; if (xx < 0 || xx >= w) continue;
					var v = B[(yy * w + xx) * 4 + c];
					if (v < lo) lo = v; if (v > hi) hi = v;
				}
			}
			var a = A[i + c], d = a < lo ? lo - a : a > hi ? a - hi : 0;
			if (d > worst) worst = d;
		}
		return worst;
	}

	// r (optional) limits the mask to a box. The outer edge (1px by default) is skipped: the
	// screenshot crop blends in the viewer background there when the iframe
	// sits on a fractional position.
	function diffMask(real, cap, w, h, threshold, r, fn, edge) {
		fn = fn || nearDiff;
		edge = edge || 1;
		var mask = new Uint8Array(w * h);
		var x0 = Math.max(edge, r ? r.x : 0), y0 = Math.max(edge, r ? r.y : 0);
		var x1 = Math.min(w - edge, r ? r.x + r.w : w), y1 = Math.min(h - edge, r ? r.y + r.h : h);
		for (var y = y0; y < y1; y++) {
			for (var x = x0; x < x1; x++) {
				var d = fn(real, cap, w, h, x, y);
				if (fn === nearDiff) d = Math.max(d, fn(cap, real, w, h, x, y));
				if (d > threshold) mask[y * w + x] = 1;
			}
		}
		return mask;
	}

	function regionRatio(mask, w, h, r) {
		var x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
		var x1 = Math.min(w, r.x + r.w), y1 = Math.min(h, r.y + r.h);
		var n = 0, d = 0;
		for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { n++; d += mask[y * w + x]; }
		return { total: n, diff: d, ratio: n ? d / n : 0 };
	}

	function level(ratio, warn, fail) { return ratio >= fail ? "fail" : ratio >= warn ? "warn" : "pass"; }

	// real / cap: ImageData of identical size. geo: geometry() in the same
	// coordinates. Returns per-region results and a diff image data URL.
	function compare(real, cap, geo) {
		var w = real.width, h = real.height;
		// Blurring spreads the blended edge pixel one more pixel inwards.
		var mask = diffMask(blur(real.data, w, h), blur(cap.data, w, h), w, h, PIXEL_THRESHOLD, null, null, 2);
		var out = { w: w, h: h };

		var excl = new Uint8Array(w * h);
		if (geo.scrollbar) {
			var sbMask = diffMask(real.data, cap.data, w, h, SCROLLBAR_THRESHOLD, geo.scrollbar, rangeDiff);
			var s = regionRatio(sbMask, w, h, geo.scrollbar);
			out.scrollbar = { ratio: s.ratio, level: s.total ? level(s.ratio, LIMITS.scrollbarWarn, LIMITS.scrollbarFail) : "pass" };
			for (var y = Math.max(0, geo.scrollbar.y); y < Math.min(h, geo.scrollbar.y + geo.scrollbar.h); y++)
				for (var x = Math.max(0, geo.scrollbar.x); x < Math.min(w, geo.scrollbar.x + geo.scrollbar.w); x++) { excl[y * w + x] = 1; mask[y * w + x] = sbMask[y * w + x]; }
		} else {
			out.scrollbar = null;
		}

		var bad = [];
		(geo.bullets || []).forEach(function (b) {
			var r = regionRatio(mask, w, h, b);
			if (r.total && r.ratio >= LIMITS.bulletFail && r.diff >= 3) bad.push(b);
		});
		out.bullets = { checked: (geo.bullets || []).length, bad: bad.length, level: bad.length ? "fail" : "pass" };

		var n = 0, d = 0;
		for (var k = 0; k < w * h; k++) { if (excl[k]) continue; n++; d += mask[k]; }
		var ratio = n ? d / n : 0;
		out.overall = { ratio: ratio, level: level(ratio, LIMITS.overallWarn, LIMITS.overallFail) };

		// Diff image: faded real rendering with differing pixels in red.
		var c = document.createElement("canvas");
		c.width = w; c.height = h;
		var ctx = c.getContext("2d");
		var img = ctx.createImageData(w, h);
		for (var p = 0; p < w * h; p++) {
			var o = p * 4;
			if (mask[p]) { img.data[o] = 230; img.data[o + 1] = 20; img.data[o + 2] = 40; }
			else {
				var g = (real.data[o] * 0.3 + real.data[o + 1] * 0.59 + real.data[o + 2] * 0.11);
				var v = Math.round(255 - (255 - g) * 0.3);
				img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
			}
			img.data[o + 3] = 255;
		}
		ctx.putImageData(img, 0, 0);
		ctx.lineWidth = 1;
		if (geo.scrollbar) {
			ctx.strokeStyle = out.scrollbar.level === "pass" ? "#1a7f37" : "#c0152f";
			ctx.strokeRect(geo.scrollbar.x + 0.5, geo.scrollbar.y + 0.5, geo.scrollbar.w - 1, geo.scrollbar.h - 1);
		}
		ctx.strokeStyle = "#e08a00";
		bad.forEach(function (b) { ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); });
		out.diffUrl = c.toDataURL("image/png");

		var levels = [out.scrollbar ? out.scrollbar.level : "pass", out.bullets.level, out.overall.level];
		out.level = levels.indexOf("fail") >= 0 ? "fail" : levels.indexOf("warn") >= 0 ? "warn" : "pass";
		return out;
	}

	return { geometry: geometry, styleAudit: styleAudit, compare: compare, LIMITS: LIMITS };
})();
