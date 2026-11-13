/*
 * My Day – recent ISIs, quick switcher, what changed since yesterday and a
 * daily summary, plus favourites and the pending queue. Activity comes from the viewer panel (content.js, logged by
 * background.js); the ISI list and changes come from scanning the repo folder
 * the user connects (File System Access API, read-only).
 */
(function () {
	"use strict";

	var DAY = 86400000;
	var SKIP_DIR = /^(\.|node_modules$|lib$|TheBrief)/;
	var state = {
		recent: [], activity: {}, scan: null, baseline: null, baseUrl: "",
		favorites: {}, pendingSince: {},
		results: [], active: 0, handle: null, scanning: false
	};

	function $(id) { return document.getElementById(id); }

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/* ----------------------------- dates ----------------------------- */
	function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

	function dayKey(ts) {
		var d = new Date(ts);
		return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
	}

	function dayStart(key) {
		var p = key.split("-").map(Number);
		return new Date(p[0], p[1] - 1, p[2]).getTime();
	}

	function longDate(key) {
		return new Date(dayStart(key)).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
	}

	function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

	function ago(ts) {
		if (!ts) return "";
		var s = (Date.now() - ts) / 1000;
		if (s < 60) return "just now";
		if (s < 3600) return Math.floor(s / 60) + " min ago";
		var today = startOfDay(Date.now());
		if (ts >= today) return "today " + fmtTime(ts);
		if (ts >= today - DAY) return "yesterday " + fmtTime(ts);
		return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + fmtTime(ts);
	}

	/* --------------------------- viewer links --------------------------- */
	function deriveBase(url) {
		var i = (url || "").indexOf("/clients/");
		return i >= 0 ? url.slice(0, i + 1) : "";
	}

	function currentBase() {
		if (state.baseUrl) return state.baseUrl;
		for (var i = 0; i < state.recent.length; i++) {
			var b = deriveBase(state.recent[i].url);
			if (b) return b;
		}
		return "";
	}

	function urlFor(isi) {
		var base = currentBase();
		if (base && isi.key && isi.key.indexOf("/") > 0) {
			return base + "clients/" + isi.key.split("/").map(encodeURIComponent).join("/") +
				"/lib/toptobottomviewer/index.htm?isiID=" + encodeURIComponent(isi.isiID) +
				(isi.version ? "&isiVer=" + encodeURIComponent(isi.version) : "");
		}
		return isi.url || "";
	}

	function openIsi(isi) {
		var url = urlFor(isi);
		if (!url) {
			$("baseHint").textContent = "Set the viewer base URL below so this ISI can be opened.";
			$("baseUrl").focus();
			return;
		}
		chrome.tabs.create({ url: url });
	}

	/* ----------------------------- ISI list ----------------------------- */
	function allIsis() {
		var map = {};
		if (state.scan) {
			Object.keys(state.scan.isis).forEach(function (k) {
				map[k] = Object.assign({}, state.scan.isis[k]);
			});
		}
		state.recent.forEach(function (r) {
			var it = map[r.key];
			if (it) it.lastVisit = r.at;
			else map[r.key] = Object.assign({}, r, { lastVisit: r.at });
		});
		Object.keys(state.favorites).forEach(function (k) {
			if (!map[k]) map[k] = Object.assign({}, state.favorites[k]);
		});
		return Object.keys(map).map(function (k) { return map[k]; });
	}

	function latestInfo(isi) {
		// Prefer the scanned version (current files) over the one in a recent URL.
		var s = state.scan && state.scan.isis[isi.key];
		return s ? Object.assign({}, isi, { version: s.version || isi.version }) : isi;
	}

	function search(q) {
		var toks = q.toLowerCase().split(/\s+/).filter(Boolean);
		if (!toks.length) return [];
		var scored = [];
		allIsis().forEach(function (it) {
			var hay = [it.isiID, it.client, it.brand, it.status, it.key].join(" ").toLowerCase();
			if (!toks.every(function (t) { return hay.indexOf(t) >= 0; })) return;
			var id = (it.isiID || "").toLowerCase();
			var t0 = toks[0];
			var s = id === t0 ? 100 : id.indexOf(t0) === 0 ? 50 : id.indexOf(t0) >= 0 ? 20 : 0;
			if (it.status === "approved") s += 3;
			if (it.lastVisit) s += 10;
			if (isFav(it)) s += 40;
			scored.push([s, it]);
		});
		scored.sort(function (a, b) { return b[0] - a[0] || String(a[1].isiID).localeCompare(String(b[1].isiID)); });
		return scored.slice(0, 15).map(function (x) { return x[1]; });
	}

	/* ------------------------------ rendering ------------------------------ */
	function badge(text, cls) { return el("span", "badge" + (cls ? " " + cls : ""), text); }

	function isiRow(isi, opts) {
		opts = opts || {};
		var li = el("li");
		if (isi.key) li.appendChild(starButton(isi));
		var main = el("div", "main");
		var head = el("div");
		head.appendChild(el("span", "id", isi.isiID || isi.key));
		if (isi.status) head.appendChild(badge(isi.status, isi.status === "approved" ? "" : "pending"));
		if (isi.version) head.appendChild(badge("v" + isi.version));
		(opts.badges || []).forEach(function (b) { head.appendChild(b); });
		main.appendChild(head);
		var meta = [isi.client, isi.brand].filter(Boolean).join(" / ");
		if (meta) main.appendChild(el("div", "meta", meta));
		(opts.details || []).forEach(function (d) { main.appendChild(el("div", "detail", d)); });
		li.appendChild(main);
		if (opts.when) li.appendChild(el("span", "when", opts.when));
		li.title = urlFor(isi) || "";
		li.addEventListener("click", function () { openIsi(isi); });
		return li;
	}

	function emptyRow(text) { return el("li", "empty", text); }

	/* ----------------------------- favourites ----------------------------- */
	function isFav(isi) { return !!(isi && isi.key && state.favorites[isi.key]); }

	function starButton(isi) {
		var on = isFav(isi);
		var b = el("button", "star" + (on ? " on" : ""), on ? "★" : "☆");
		b.type = "button";
		b.title = on ? "Remove from favourites" : "Add to favourites";
		b.addEventListener("click", function (e) {
			e.stopPropagation();
			toggleFavorite(isi);
		});
		return b;
	}

	function toggleFavorite(isi) {
		var favs = Object.assign({}, state.favorites);
		if (favs[isi.key]) delete favs[isi.key];
		else {
			favs[isi.key] = {
				key: isi.key, isiID: isi.isiID, client: isi.client || "", brand: isi.brand || "",
				status: isi.status || "", version: isi.version || "", url: isi.url || "", addedAt: Date.now()
			};
		}
		state.favorites = favs;
		renderFavRelated();
		return chrome.storage.local.set({ favorites: favs });
	}

	function renderFavorites() {
		var ul = $("favList");
		ul.textContent = "";
		var keys = Object.keys(state.favorites);
		$("favCount").textContent = keys.length ? "(" + keys.length + ")" : "";
		if (!keys.length) {
			ul.appendChild(emptyRow("Click ☆ next to any ISI (here or in the viewer panel) to pin it."));
			return;
		}
		var visits = {};
		state.recent.forEach(function (r) { visits[r.key] = r.at; });
		keys.map(function (k) { return state.favorites[k]; })
			.sort(function (a, b) { return String(a.isiID).localeCompare(String(b.isiID)) || String(a.status).localeCompare(String(b.status)); })
			.forEach(function (f) {
				ul.appendChild(isiRow(latestInfo(f), { when: visits[f.key] ? "opened " + ago(visits[f.key]) : "" }));
			});
	}

	function renderFavRelated() {
		renderFavorites();
		renderResults();
		renderRecent();
		renderPending();
		renderChanges();
	}

	/* ---------------------------- pending queue ---------------------------- */
	function cmpVer(a, b) {
		var x = String(a || "").split(/[.\-]/), y = String(b || "").split(/[.\-]/);
		for (var i = 0; i < Math.max(x.length, y.length); i++) {
			var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
			if (p !== q) return p < q ? -1 : 1;
		}
		return 0;
	}

	function daysSince(ts) { return Math.max(0, Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / DAY)); }

	function computePending() {
		if (!state.scan) return null;
		var isis = state.scan.isis;
		return Object.keys(isis).filter(function (k) { return isis[k].status === "pending"; }).map(function (k) {
			var it = isis[k];
			var ps = state.pendingSince[k];
			var since = ps && ps.at ? ps.at : it.mtime;
			var approved = isis[k.replace(/\/pending$/, "/approved")] || null;
			return {
				it: it, since: since, days: since ? daysSince(since) : 0, approved: approved,
				stale: !!(approved && it.version && approved.version && cmpVer(it.version, approved.version) <= 0)
			};
		}).sort(function (a, b) { return (a.since || 0) - (b.since || 0); });
	}

	function renderPending() {
		var ul = $("pendingList");
		ul.textContent = "";
		var list = computePending();
		$("pendingCount").textContent = list && list.length ? "(" + list.length + ")" : "";
		if (!list) {
			ul.appendChild(emptyRow("Connect the repo folder (“What changed since yesterday”) to list every ISI waiting in a pending folder."));
			return;
		}
		if (!list.length) {
			ul.appendChild(emptyRow("No ISIs are pending. 🎉"));
			return;
		}
		list.forEach(function (p) {
			var badges = [];
			var label = p.days === 0 ? "today" : p.days === 1 ? "1 day" : p.days + " days";
			badges.push(badge("waiting " + label, "age" + (p.days >= 7 ? " old" : p.days >= 3 ? " warn" : "")));
			if (p.approved) {
				var c = p.stale ? cmpVer(p.it.version, p.approved.version) : 1;
				badges.push(badge(c === 0 ? "same version as approved" : c < 0 ? "older than approved v" + p.approved.version : "approved v" + p.approved.version, p.stale ? "same" : ""));
			} else {
				badges.push(badge("no approved yet", "new"));
			}
			var details = [];
			var h = p.it.currentHistory || p.it.history;
			if (h && h.changes.length) {
				details.push("Latest history" + (h.version ? " (v" + h.version + ")" : "") + ": " + h.changes.join("; "));
			}
			if (p.since) details.push("Pending since " + new Date(p.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
			ul.appendChild(isiRow(p.it, { badges: badges, details: details }));
		});
	}

	function renderResults() {
		var ul = $("results");
		ul.textContent = "";
		var q = $("q").value.trim();
		state.results = search(q);
		if (state.active >= state.results.length) state.active = 0;
		state.results.forEach(function (it, i) {
			var li = isiRow(latestInfo(it), { when: it.lastVisit ? "opened " + ago(it.lastVisit) : "" });
			if (i === state.active) li.classList.add("active");
			li.addEventListener("mouseenter", function () { state.active = i; markActive(); });
			ul.appendChild(li);
		});
		if (q && !state.results.length) ul.appendChild(emptyRow("No ISI matches “" + q + "”."));

		var hints = [];
		if (!state.scan) hints.push("Connect the repo folder (below) to search every ISI; until then only recent ISIs are searchable.");
		else hints.push(Object.keys(state.scan.isis).length + " ISIs indexed. ↑/↓ to move, Enter to open.");
		if (!currentBase()) hints.push("Open any viewer once, or set the viewer base URL at the bottom, so links can be built.");
		$("searchHint").textContent = hints.join(" ");
	}

	function markActive() {
		Array.prototype.forEach.call($("results").children, function (li, i) {
			li.classList.toggle("active", i === state.active);
		});
	}

	function renderRecent() {
		var ul = $("recentList");
		ul.textContent = "";
		if (!state.recent.length) {
			ul.appendChild(emptyRow("Open any toptobottomviewer page and it will appear here."));
			return;
		}
		state.recent.forEach(function (r) {
			ul.appendChild(isiRow(latestInfo(r), { when: ago(r.at) }));
		});
	}

	function computeChanges() {
		if (!state.scan) return [];
		var since = startOfDay(Date.now()) - DAY;
		var bv = state.baseline && state.baseline.versions;
		var out = [];
		Object.keys(state.scan.isis).forEach(function (k) {
			var it = state.scan.isis[k];
			var changed = it.files.filter(function (f) { return f.mtime >= since; })
				.sort(function (a, b) { return b.mtime - a.mtime; });
			var bump = null, isNew = false;
			if (bv) {
				if (!(k in bv)) isNew = true;
				else if (bv[k] !== it.version) bump = bv[k];
			}
			var h = it.history;
			var approvedRecent = !!(h && h.ts && h.ts >= since);
			if (!changed.length && !bump && !isNew && !approvedRecent) return;
			out.push({
				it: it, changed: changed, bump: bump, isNew: isNew, approvedRecent: approvedRecent,
				latest: changed.length ? changed[0].mtime : 0,
				sortKey: Math.max(changed.length ? changed[0].mtime : 0, approvedRecent ? h.ts : 0)
			});
		});
		out.sort(function (a, b) {
			return (b.isNew || !!b.bump) - (a.isNew || !!a.bump) || b.sortKey - a.sortKey;
		});
		return out;
	}

	function renderChanges() {
		var ul = $("changeList");
		ul.textContent = "";
		if (!state.scan) {
			ul.appendChild(emptyRow("Connect your local Banners_TheBrief_ISIs folder to see ISIs whose files, version or approval history changed since yesterday."));
			return;
		}
		var list = computeChanges();
		if (!list.length) {
			ul.appendChild(emptyRow("Nothing changed since yesterday."));
			return;
		}
		list.forEach(function (c) {
			var badges = [];
			if (c.isNew) badges.push(badge("new", "new"));
			if (c.bump) badges.push(badge((c.bump ? "v" + c.bump : "?") + " → v" + c.it.version, "bump"));
			if (c.approvedRecent) badges.push(badge("approved " + c.it.history.date, "approved-recent"));
			var details = [];
			if (c.changed.length) {
				details.push("Files: " + c.changed.slice(0, 6).map(function (f) {
					return f.name + " (" + ago(f.mtime) + ")";
				}).join(", ") + (c.changed.length > 6 ? ", +" + (c.changed.length - 6) + " more" : ""));
			}
			var h = c.it.history;
			if (h && (c.approvedRecent || c.bump) && h.changes.length) {
				details.push("Latest history (" + h.date + (h.version ? ", v" + h.version : "") + "): " + h.changes.join("; "));
			}
			ul.appendChild(isiRow(c.it, { badges: badges, details: details, when: c.latest ? ago(c.latest) : "" }));
		});
	}

	/* ----------------------------- summary ----------------------------- */
	function renderDays() {
		var sel = $("daySelect");
		var keep = sel.value;
		var today = dayKey(Date.now());
		var yesterday = dayKey(Date.now() - DAY);
		var days = Object.keys(state.activity);
		if (days.indexOf(today) < 0) days.push(today);
		days.sort().reverse();
		sel.textContent = "";
		days.forEach(function (k) {
			var label = k === today ? "Today" : k === yesterday ? "Yesterday" : longDate(k);
			var n = state.activity[k] ? Object.keys(state.activity[k].isis).length : 0;
			var o = el("option", null, label + (n ? " (" + n + " ISI" + (n === 1 ? "" : "s") + ")" : ""));
			o.value = k;
			sel.appendChild(o);
		});
		sel.value = days.indexOf(keep) >= 0 ? keep : today;
	}

	function downloadText(dl, label) {
		if (!dl) return "";
		return label + (dl.count > 1 ? " ×" + dl.count : "") + (dl.options > 1 ? " (" + dl.options + " options)" : "");
	}

	function buildSummary(day, incFiles) {
		var lines = ["Daily summary – " + longDate(day), ""];
		var d = state.activity[day];
		var isis = d ? Object.keys(d.isis).map(function (k) { return Object.assign({ key: k }, d.isis[k]); }) : [];
		isis.sort(function (a, b) { return a.firstAt - b.firstAt; });

		if (isis.length) {
			lines.push("ISIs worked on (" + isis.length + "):");
			isis.forEach(function (e) {
				var where = [e.client, e.brand, e.status].filter(Boolean).join(" / ");
				var ver = e.versions && e.versions.length ? " – v" + e.versions.join(", v") : "";
				var span = fmtTime(e.firstAt) === fmtTime(e.lastAt) ? fmtTime(e.firstAt) : fmtTime(e.firstAt) + "–" + fmtTime(e.lastAt);
				lines.push("• " + e.isiID + (where ? " – " + where : "") + ver + " (" + span + ")");
				var acts = [];
				if (e.views) acts.push("viewed " + e.views + "×");
				var tray = downloadText(e.downloads && e.downloads.tray, "tray ZIP");
				var tb = downloadText(e.downloads && e.downloads.toptobottom, "top-to-bottom ZIP");
				if (tray) acts.push("downloaded " + tray);
				if (tb) acts.push((tray ? "" : "downloaded ") + tb);
				if (acts.length) lines.push("  " + acts.join("; "));
			});
		} else {
			lines.push("No ISIs opened in the viewer on this day.");
		}

		if (incFiles && state.scan) {
			var s = dayStart(day), end = s + DAY;
			var changed = [];
			Object.keys(state.scan.isis).forEach(function (k) {
				var it = state.scan.isis[k];
				var files = it.files.filter(function (f) { return f.mtime >= s && f.mtime < end; }).map(function (f) { return f.name; });
				if (files.length) changed.push({ it: it, files: files });
			});
			if (changed.length) {
				changed.sort(function (a, b) { return a.it.isiID.localeCompare(b.it.isiID); });
				lines.push("", "Repo files changed (" + changed.length + "):");
				changed.forEach(function (c) {
					var where = [c.it.client, c.it.status].filter(Boolean).join(" / ");
					lines.push("• " + c.it.isiID + (where ? " – " + where : "") + (c.it.version ? " – v" + c.it.version : "") +
						": " + c.files.join(", "));
				});
			}
		}
		return lines.join("\n");
	}

	function renderSummary() {
		$("summaryText").value = buildSummary($("daySelect").value || dayKey(Date.now()), $("incFiles").checked);
	}

	function renderAll() {
		$("todayLabel").textContent = longDate(dayKey(Date.now()));
		renderResults();
		renderFavorites();
		renderPending();
		renderRecent();
		renderChanges();
		renderDays();
		renderSummary();
		var auto = !state.baseUrl && currentBase();
		if (document.activeElement !== $("baseUrl")) $("baseUrl").value = currentBase();
		$("baseHint").textContent = state.baseUrl ? "Saved." : auto ? "Auto-detected from your recent viewers." : "";
	}

	/* -------------------------- repo folder scan -------------------------- */
	function idb() {
		return new Promise(function (res, rej) {
			var r = indexedDB.open("myday", 1);
			r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
			r.onsuccess = function () { res(r.result); };
			r.onerror = function () { rej(r.error); };
		});
	}
	function idbReq(mode, fn) {
		return idb().then(function (db) {
			return new Promise(function (res, rej) {
				var req = fn(db.transaction("kv", mode).objectStore("kv"));
				req.onsuccess = function () { res(req.result); };
				req.onerror = function () { rej(req.error); };
			});
		});
	}
	function idbGet(k) { return idbReq("readonly", function (s) { return s.get(k); }); }
	function idbSet(k, v) { return idbReq("readwrite", function (s) { return s.put(v, k); }); }

	function parseHistoryDate(str) {
		var m = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(str || "");
		if (!m) return 0;
		var a = +m[1], b = +m[2], y = +m[3];
		if (y < 100) y += 2000;
		// The repo mostly uses M.D.YYYY, but some histories use D.M.YYYY.
		var mon = a, day = b;
		if (a > 12 && b <= 12) { mon = b; day = a; }
		var d = new Date(y, mon - 1, day);
		if (d.getMonth() !== mon - 1 || d.getDate() !== day) return 0;
		// Ignore typo'd dates in the future.
		if (d.getTime() > Date.now() + DAY) return 0;
		return d.getTime();
	}

	function parseHistory(html) {
		var doc = new DOMParser().parseFromString(html, "text/html");
		var rows = doc.querySelectorAll("tr.data");
		var best = null, byVersion = {};
		Array.prototype.forEach.call(rows, function (tr) {
			var cell = function (name) {
				var c = tr.querySelector('td[data="' + name + '"]');
				return c ? c : null;
			};
			var dateCell = cell("date approved");
			var entry = {
				date: dateCell ? dateCell.textContent.trim() : "",
				version: cell("isi version") ? cell("isi version").textContent.trim() : "",
				changes: cell("changes") ? Array.prototype.map.call(cell("changes").querySelectorAll("li"), function (li) {
					return li.textContent.replace(/\s+/g, " ").trim();
				}).filter(Boolean) : []
			};
			entry.ts = parseHistoryDate(entry.date);
			if (!best || (entry.ts && entry.ts >= best.ts)) best = entry;
			if (entry.version) byVersion[entry.version] = byVersion[entry.version] || entry;
		});
		if (best) best.byVersion = byVersion;
		return best;
	}

	function hasViewer(lib) {
		return lib.getDirectoryHandle("toptobottomviewer")
			.then(function (v) { return v.getFileHandle("index.htm"); })
			.then(function () { return true; }, function () { return false; });
	}

	async function readIsi(parts, files) {
		var info = {
			key: parts.join("/"),
			isiID: parts[parts.length - 2],
			client: parts.length > 2 ? parts[0] : "",
			brand: parts.length > 3 ? parts.slice(1, -2).join(" / ") : "",
			status: parts[parts.length - 1],
			version: "", files: [], mtime: 0, history: null
		};
		for (var i = 0; i < files.length; i++) {
			var fh = files[i];
			if (fh.name.charAt(0) === ".") continue;
			var f = await fh.getFile();
			info.files.push({ name: fh.name, mtime: f.lastModified });
			info.mtime = Math.max(info.mtime, f.lastModified);
			if (fh.name === "isiText.js") {
				var t = await f.text();
				var v = /\bisiVer\s*=\s*["']([^"']+)["']/.exec(t);
				var id = /\bisiID\s*=\s*["']([^"']+)["']/.exec(t);
				if (v) info.version = v[1];
				if (id) info.isiID = id[1];
			} else if (fh.name === "history.htm") {
				try { info.history = parseHistory(await f.text()); } catch (e) { /* ignore bad history */ }
			}
		}
		// Keep only the history row for the current version (if any) to keep storage small.
		if (info.history) {
			var cur = info.history.byVersion[info.version];
			delete info.history.byVersion;
			if (cur && cur !== info.history) info.currentHistory = { version: cur.version, changes: cur.changes };
		}
		return info;
	}

	async function scanRepo(root, onProgress) {
		var clients = root;
		if (root.name !== "clients") {
			try { clients = await root.getDirectoryHandle("clients"); }
			catch (e) { throw new Error("That folder has no “clients” folder. Pick your Banners_TheBrief_ISIs folder (or its clients folder)."); }
		}
		var isis = {};
		var count = 0;
		async function walk(dir, parts, depth) {
			if (depth > 8) return;
			var dirs = [], files = [];
			for await (var h of dir.values()) (h.kind === "directory" ? dirs : files).push(h);
			var lib = dirs.filter(function (d) { return d.name === "lib"; })[0];
			if (lib && parts.length >= 2 && await hasViewer(lib)) {
				var info = await readIsi(parts, files);
				isis[info.key] = info;
				onProgress(++count);
				return;
			}
			await Promise.all(dirs.filter(function (d) { return !SKIP_DIR.test(d.name); }).map(function (d) {
				return walk(d, parts.concat(d.name), depth + 1);
			}));
		}
		await walk(clients, [], 0);
		return isis;
	}

	async function saveScan(isis, rootName) {
		var now = Date.now();
		var prev = state.scan;
		var baseline = state.baseline;
		// Version bumps compare against the last scan taken before today.
		if (prev && prev.at < startOfDay(now)) {
			var versions = {};
			Object.keys(prev.isis).forEach(function (k) { versions[k] = prev.isis[k].version; });
			baseline = { at: prev.at, versions: versions };
		}
		var scan = { at: now, root: rootName, isis: isis };
		state.scan = scan;
		state.baseline = baseline;
		state.pendingSince = updatePendingSince(isis, now);
		await chrome.storage.local.set({ scan: scan, baseline: baseline || null, pendingSince: state.pendingSince });
	}

	// Pending history has no approval date, so remember when each pending
	// version was first seen. On the first scan (or a new pending version) the
	// newest file time in the folder is the best estimate.
	function updatePendingSince(isis, now) {
		var next = {};
		Object.keys(isis).forEach(function (k) {
			var it = isis[k];
			if (it.status !== "pending") return;
			var prev = state.pendingSince[k];
			if (prev && prev.version === it.version) next[k] = prev;
			else next[k] = { at: Math.min(now, it.mtime || now), version: it.version };
		});
		return next;
	}

	async function runScan() {
		if (!state.handle || state.scanning) return;
		state.scanning = true;
		var status = $("scanStatus");
		status.textContent = "Scanning…";
		var t0 = Date.now();
		try {
			var isis = await scanRepo(state.handle, function (n) { status.textContent = "Scanning… " + n + " ISIs"; });
			await saveScan(isis, state.handle.name);
			status.textContent = Object.keys(isis).length + " ISIs in “" + state.handle.name + "”, scanned " +
				ago(state.scan.at) + " (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)." +
				(state.baseline ? "" : " Version bumps are tracked from tomorrow, against today’s scan.");
			renderAll();
		} catch (err) {
			status.textContent = "Scan failed: " + (err && err.message ? err.message : err);
		} finally {
			state.scanning = false;
		}
	}

	async function connectFolder() {
		if (!window.showDirectoryPicker) {
			$("scanStatus").textContent = "This browser can't read folders. Use Chrome or Edge.";
			return;
		}
		try {
			if (state.handle && (await state.handle.queryPermission({ mode: "read" })) === "prompt") {
				if ((await state.handle.requestPermission({ mode: "read" })) === "granted") {
					updateRepoButtons();
					return runScan();
				}
			}
			var handle = await window.showDirectoryPicker({ id: "isi-repo", mode: "read" });
			state.handle = handle;
			await idbSet("repo", handle);
			updateRepoButtons();
			await runScan();
		} catch (err) {
			if (err && err.name === "AbortError") return;
			$("scanStatus").textContent = "Couldn't open the folder: " + (err && err.message ? err.message : err);
		}
	}

	async function updateRepoButtons() {
		var connect = $("connectBtn"), rescan = $("rescanBtn");
		if (!state.handle) { connect.textContent = "Connect repo folder…"; rescan.hidden = true; return; }
		var perm = "prompt";
		try { perm = await state.handle.queryPermission({ mode: "read" }); } catch (e) {}
		if (perm === "granted") {
			connect.textContent = "Change folder…";
			rescan.hidden = false;
		} else {
			connect.textContent = "Reconnect “" + state.handle.name + "”";
			rescan.hidden = true;
			if (state.scan) $("scanStatus").textContent = "Showing the scan from " + ago(state.scan.at) + ". Reconnect to refresh.";
		}
		return perm;
	}

	/* ------------------------------- events ------------------------------- */
	function wire() {
		var q = $("q");
		q.addEventListener("input", function () { state.active = 0; renderResults(); });
		q.addEventListener("keydown", function (e) {
			var n = state.results.length;
			if (e.key === "ArrowDown" && n) { state.active = (state.active + 1) % n; markActive(); e.preventDefault(); }
			else if (e.key === "ArrowUp" && n) { state.active = (state.active - 1 + n) % n; markActive(); e.preventDefault(); }
			else if (e.key === "Enter" && n) { openIsi(latestInfo(state.results[state.active])); e.preventDefault(); }
			else if (e.key === "Escape") { q.value = ""; renderResults(); }
		});
		document.addEventListener("keydown", function (e) {
			var t = e.target;
			var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
			if (e.key === "/" && !typing) { e.preventDefault(); q.focus(); q.select(); }
		});

		$("connectBtn").addEventListener("click", connectFolder);
		$("rescanBtn").addEventListener("click", runScan);
		$("daySelect").addEventListener("change", renderSummary);
		$("incFiles").addEventListener("change", renderSummary);
		$("copyBtn").addEventListener("click", function () {
			var text = $("summaryText").value;
			navigator.clipboard.writeText(text).then(function () {
				$("copyStatus").textContent = "Copied ✓";
			}, function () {
				$("summaryText").select();
				document.execCommand("copy");
				$("copyStatus").textContent = "Copied ✓";
			});
			setTimeout(function () { $("copyStatus").textContent = ""; }, 2500);
		});
		$("saveBase").addEventListener("click", function () {
			var v = $("baseUrl").value.trim();
			if (v) {
				var cut = deriveBase(v);
				if (cut) v = cut;
				if (!/\/$/.test(v)) v += "/";
			}
			state.baseUrl = v;
			chrome.storage.local.set({ baseUrl: v }).then(renderAll);
		});

		chrome.storage.onChanged.addListener(function (changes, area) {
			if (area !== "local") return;
			if (changes.recent) state.recent = changes.recent.newValue || [];
			if (changes.activity) state.activity = changes.activity.newValue || {};
			if (changes.favorites) {
				state.favorites = changes.favorites.newValue || {};
				renderFavRelated();
			}
			if (changes.recent || changes.activity) {
				renderResults();
				renderRecent();
				renderDays();
				renderSummary();
			}
		});
	}

	async function init() {
		wire();
		var data = await chrome.storage.local.get(["recent", "activity", "scan", "baseline", "baseUrl", "favorites", "pendingSince"]);
		state.favorites = data.favorites || {};
		state.pendingSince = data.pendingSince || {};
		state.recent = data.recent || [];
		state.activity = data.activity || {};
		state.scan = data.scan || null;
		state.baseline = data.baseline || null;
		state.baseUrl = data.baseUrl || "";
		renderAll();
		$("q").focus();

		try { state.handle = (await idbGet("repo")) || null; } catch (e) { state.handle = null; }
		var perm = await updateRepoButtons();
		if (perm === "granted") runScan();
		else if (state.scan && !state.handle) $("scanStatus").textContent = "Last scan " + ago(state.scan.at) + ".";

		// Keep relative times fresh.
		setInterval(function () { renderRecent(); renderChanges(); renderFavorites(); renderPending(); }, 60000);
	}

	// Exposed for automated tests (scan a mock directory handle).
	window.__myday = { scanRepo: scanRepo, saveScan: saveScan, renderAll: renderAll, buildSummary: buildSummary, toggleFavorite: toggleFavorite, computePending: computePending, state: state };

	init();
})();
