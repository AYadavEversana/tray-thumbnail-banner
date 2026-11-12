/* All-brands rendering audit (extension page). */
(function () {
	"use strict";

	var $ = function (id) { return document.getElementById(id); };
	var items = [];        // { client, brand, isi, status, version, url, selected }
	var results = {};      // index -> result from the audited page
	var running = null;    // { run, winId, tabId, stop }

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
		});
	}
	function badge(level, text) { return "<span class='" + level + "'>" + esc(text) + "</span>"; }
	function pct(r) { return (r * 100).toFixed(r < 0.01 ? 2 : 1) + "%"; }
	function worst(levels) { return levels.indexOf("fail") >= 0 ? "fail" : levels.indexOf("warn") >= 0 ? "warn" : "pass"; }

	var params = new URLSearchParams(location.search);
	$("base").value = params.get("base") || "";

	function baseUrl() {
		var b = $("base").value.trim();
		if (b && !/\/$/.test(b)) b += "/";
		return b;
	}

	/* ------------------------- find pages ------------------------- */
	// Path segments starting at "clients". Picking a single client folder works too.
	function clientsPath(rel) {
		var p = rel.split("/");
		var ci = p.indexOf("clients");
		return ci >= 0 ? p.slice(ci) : ["clients"].concat(p);
	}

	$("pick").addEventListener("click", function () { $("dir").click(); });
	$("dir").addEventListener("change", function () {
		var files = Array.prototype.slice.call($("dir").files || []);
		var isiTexts = {};
		var pages = [];
		files.forEach(function (f) {
			var p = clientsPath(f.webkitRelativePath || f.name);
			var n = p.length;
			if (p[n - 1] === "isiText.js") isiTexts[p.slice(0, n - 1).join("/")] = f;
			if (p[n - 1] === "index.htm" && p[n - 2] === "toptobottomviewer" && p[n - 3] === "lib" && n >= 6) pages.push(p);
		});
		if (!pages.length) {
			$("progress").textContent = "";
			alert("No toptobottomviewer pages were found in that folder. Choose the project's clients folder.");
			return;
		}
		var found = pages.map(function (p) {
			var L = p.length - 3;
			var dir = p.slice(0, L).join("/");
			return {
				client: p[1],
				brand: p.slice(2, L - 2).join(" / ") || "—",
				isi: p[L - 2],
				status: p[L - 1],
				version: "",
				path: p.map(encodeURIComponent).join("/"),
				isiText: isiTexts[dir] || null,
				selected: true
			};
		});
		Promise.all(found.map(function (it) {
			if (!it.isiText) return null;
			return it.isiText.text().then(function (t) {
				var v = t.match(/isiVer\s*=\s*["']([^"']+)["']/);
				var id = t.match(/isiID\s*=\s*["']([^"']+)["']/);
				if (v) it.version = v[1];
				if (id) it.isi = id[1];
			}).catch(function () {});
		})).then(function () {
			found.forEach(function (it) { delete it.isiText; });
			found.sort(function (a, b) { return (a.client + a.brand + a.isi + a.status).localeCompare(b.client + b.brand + b.isi + b.status); });
			setItems(found);
		});
	});

	$("addUrls").addEventListener("click", function () {
		var lines = $("urls").value.split(/\s+/).filter(function (l) { return /^(https?|file):\/\//i.test(l); });
		var added = lines.map(function (u) {
			var url;
			try { url = new URL(u.split("#")[0]); } catch (e) { return null; }
			var seg = url.pathname.split("/").map(decodeURIComponent);
			var L = seg.lastIndexOf("lib");
			return {
				client: "—", brand: "—",
				isi: url.searchParams.get("isiID") || (L > 1 ? seg[L - 2] : url.pathname),
				status: L > 0 ? seg[L - 1] : "",
				version: url.searchParams.get("isiVer") || "",
				absUrl: url.href,
				selected: true
			};
		}).filter(Boolean);
		if (!added.length) { alert("Paste full viewer URLs, one per line."); return; }
		setItems(items.concat(added));
	});

	function pageUrl(it) {
		if (it.absUrl) return it.absUrl;
		var u = baseUrl() + it.path + "?isiID=" + encodeURIComponent(it.isi);
		if (it.version) u += "&isiVer=" + encodeURIComponent(it.version);
		return u;
	}

	/* --------------------------- list --------------------------- */
	function setItems(list) {
		items = list;
		results = {};
		var clients = {};
		items.forEach(function (it) { clients[it.client] = true; });
		$("fClient").innerHTML = "<option value=''>All clients</option>" +
			Object.keys(clients).sort().map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("");
		$("listCard").hidden = false;
		renderList();
	}

	function shown(it) {
		var c = $("fClient").value, s = $("fStatus").value, t = $("fText").value.trim().toLowerCase();
		if (c && it.client !== c) return false;
		if (s && it.status !== s) return false;
		if (t && (it.isi + " " + it.brand + " " + it.client).toLowerCase().indexOf(t) < 0) return false;
		return true;
	}

	function renderList() {
		var rows = items.map(function (it, i) {
			if (!shown(it)) return "";
			return "<tr><td><input type='checkbox' data-i='" + i + "'" + (it.selected ? " checked" : "") + "></td><td>" + esc(it.client) + "</td><td>" + esc(it.brand) +
				"</td><td>" + esc(it.isi) + "</td><td>" + esc(it.status) + "</td><td>" + esc(it.version || "—") + "</td></tr>";
		}).join("");
		$("list").querySelector("tbody").innerHTML = rows;
		updateCount();
	}

	function selectedItems() {
		return items.map(function (it, i) { return { it: it, i: i }; }).filter(function (x) { return x.it.selected && shown(x.it); });
	}

	function updateCount() {
		if (!running) $("progress").textContent = selectedItems().length + " of " + items.length + " pages selected.";
	}

	$("list").addEventListener("change", function (e) {
		var i = e.target.getAttribute("data-i");
		if (i != null) { items[+i].selected = e.target.checked; updateCount(); }
	});
	["fClient", "fStatus"].forEach(function (id) { $(id).addEventListener("change", renderList); });
	$("fText").addEventListener("input", renderList);
	$("selAll").addEventListener("click", function () { items.forEach(function (it) { if (shown(it)) it.selected = true; }); renderList(); });
	$("selNone").addEventListener("click", function () { items.forEach(function (it) { if (shown(it)) it.selected = false; }); renderList(); });

	/* --------------------------- run --------------------------- */
	var waiters = {};
	chrome.runtime.onMessage.addListener(function (msg) {
		if (!msg || msg.type !== "__trayAuditResult" || !running || msg.run !== running.run) return;
		var w = waiters[msg.idx];
		if (w) { delete waiters[msg.idx]; w(msg.result); }
	});

	function waitResult(idx, ms) {
		return new Promise(function (resolve) {
			var t = setTimeout(function () {
				delete waiters[idx];
				resolve({ error: "Timed out. The page did not finish loading, or the extension can't run on it (for file:// pages, enable “Allow access to file URLs”)." });
			}, ms);
			waiters[idx] = function (r) { clearTimeout(t); resolve(r); };
			running.cancel = function () { clearTimeout(t); delete waiters[idx]; resolve(null); };
		});
	}

	function setRunning(on) {
		$("start").disabled = on;
		$("stop").hidden = !on;
		$("pick").disabled = on;
	}

	$("start").addEventListener("click", function () {
		var todo = selectedItems();
		if (!todo.length) { alert("Select at least one page."); return; }
		if (todo.some(function (x) { return !x.it.absUrl; }) && !/^(file|https?):\/\//i.test(baseUrl())) {
			alert("Enter the project location (the folder that contains clients/), e.g. file:///Users/you/.../Banners_TheBrief_ISIs/");
			return;
		}
		var pixel = $("pixel").checked;
		results = {};
		running = { run: Date.now().toString(36), stop: false };
		setRunning(true);
		$("resultCard").hidden = false;
		renderResults();

		chrome.windows.create({ url: "about:blank", focused: true, width: 1400, height: 950, type: "normal" }, function (win) {
			if (!win) { setRunning(false); running = null; alert("Could not open the audit window."); return; }
			running.winId = win.id;
			running.tabId = win.tabs[0].id;
			var n = 0;
			var chain = Promise.resolve();
			todo.forEach(function (x) {
				chain = chain.then(function () {
					if (running.stop) return;
					n++;
					$("progress").textContent = "Auditing " + n + " of " + todo.length + ": " + x.it.isi + " (" + x.it.status + ")…";
					var url = pageUrl(x.it).split("#")[0] + "#trayAudit=" + running.run + "&idx=" + x.i + (pixel ? "&pixel=1" : "");
					return new Promise(function (resolve) {
						chrome.tabs.update(running.tabId, { url: url, active: true }, function () {
							if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
							resolve(waitResult(x.i, pixel ? 180000 : 60000));
						});
					}).then(function (r) {
						if (r) { results[x.i] = r; renderResults(); }
					});
				});
			});
			chain.then(finish, finish);
		});
	});

	function finish() {
		if (!running) return;
		var winId = running.winId;
		var stopped = running.stop;
		running = null;
		setRunning(false);
		if (winId != null) chrome.windows.remove(winId, function () { void chrome.runtime.lastError; });
		var done = Object.keys(results).length;
		$("progress").textContent = (stopped ? "Stopped after " : "Finished: ") + done + " page(s) audited.";
		renderResults();
		saveLast();
	}

	$("stop").addEventListener("click", function () {
		if (!running) return;
		running.stop = true;
		if (running.cancel) running.cancel();
	});

	chrome.windows.onRemoved.addListener(function (id) {
		if (running && id === running.winId) {
			running.winId = null;
			running.stop = true;
			if (running.cancel) running.cancel();
		}
	});

	/* ------------------------- results ------------------------- */
	function pageLevel(r) {
		if (!r) return "pending";
		if (r.error) return "fail";
		return worst((r.sizes || []).map(function (s) { return s.level; }));
	}

	function findings(r) {
		if (!r) return [];
		if (r.error) return [{ level: "fail", text: r.error }];
		var groups = {};
		var order = [];
		var add = function (level, text, size) {
			var k = level + "|" + text;
			if (!groups[k]) { groups[k] = { level: level, text: text, sizes: [] }; order.push(k); }
			if (size && groups[k].sizes.indexOf(size) < 0) groups[k].sizes.push(size);
		};
		(r.sizes || []).forEach(function (s) {
			if (s.error) add("fail", "Check failed: " + s.error, s.size);
			(s.issues || []).forEach(function (i) { add(i.level, i.area + ": " + i.text, s.size); });
			var p = s.pixel;
			if (p) {
				if (p.scrollbar && p.scrollbar.level !== "pass") add(p.scrollbar.level, "Pixel: scrollbar differs from the real tray", s.size);
				if (p.bullets.level !== "pass") add(p.bullets.level, "Pixel: bullets differ from the real tray", s.size);
				if (p.overall.level !== "pass") add(p.overall.level, "Pixel: content differs from the real tray", s.size);
			}
		});
		return order.map(function (k) { return groups[k]; }).sort(function (a, b) {
			return (a.level === "fail" ? 0 : 1) - (b.level === "fail" ? 0 : 1);
		});
	}

	function sizeDetail(s) {
		var lines = [];
		if (s.error) lines.push(badge("fail", "Check failed: " + s.error));
		if (s.pixel) {
			var p = s.pixel;
			lines.push("<b>Scrollbar:</b> " + (p.scrollbar ? badge(p.scrollbar.level, p.scrollbar.level === "pass" ? "matches" : "differs") + " (" + pct(p.scrollbar.ratio) + ")" : "none on screen"));
			lines.push("<b>Bullets:</b> " + (p.bullets.checked ? badge(p.bullets.level, p.bullets.bad ? p.bullets.bad + " of " + p.bullets.checked + " differ" : "all " + p.bullets.checked + " match") : "none visible"));
			lines.push("<b>Overall:</b> " + badge(p.overall.level, pct(p.overall.ratio) + " of pixels differ"));
		}
		(s.issues || []).forEach(function (i) { lines.push(badge(i.level, i.area + ": ") + esc(i.text)); });
		if (s.note) lines.push("<span class='muted'>" + esc(s.note) + "</span>");
		var imgs = s.diffUrl ? "<td><img class='shot' src='" + s.realUrl + "'></td><td><img class='shot' src='" + s.capUrl + "'></td><td><img class='shot' src='" + s.diffUrl + "'></td>" :
			"<td colspan='3' class='muted'>" + (s.pixel ? "Images are kept only for sizes that differ." : "Pixel check was off.") + "</td>";
		return "<tr><td><b>" + esc(s.size) + "</b><br>" + badge(s.level, s.level.toUpperCase()) + "</td>" + imgs + "<td>" + lines.join("<br>") + "</td></tr>";
	}

	function resultsHtml(forReport) {
		var only = !forReport && $("fResult").value === "issues";
		var counts = { pass: 0, warn: 0, fail: 0, pending: 0 };
		var rows = [];
		items.forEach(function (it, i) {
			if (!it.selected && !results[i]) return;
			var r = results[i];
			var lvl = pageLevel(r);
			if (r || running) counts[lvl] = (counts[lvl] || 0) + 1;
			if (!r) return;
			if (only && lvl === "pass") return;
			var f = findings(r);
			var fHtml = f.length ? "<ul class='findings'>" + f.map(function (x) {
				return "<li>" + badge(x.level, x.level === "fail" ? "✖" : "⚠") + " " + esc(x.text) + (x.sizes.length ? " <span class='muted'>(" + esc(x.sizes.join(", ")) + ")</span>" : "") + "</li>";
			}).join("") + "</ul>" : badge("pass", "No issues");
			var detail = (r.sizes && r.sizes.length) ? "<details><summary>Per-size details (" + r.sizes.length + ")</summary><table><tr><th>Size</th><th>Real</th><th>Downloaded</th><th>Differences</th><th>Result</th></tr>" +
				r.sizes.map(sizeDetail).join("") + "</table></details>" : "";
			rows.push("<tr><td>" + esc(it.client) + "</td><td>" + esc(it.brand) + "</td><td><b>" + esc(it.isi) + "</b></td><td>" + esc(it.status) +
				"</td><td>" + esc(r.version || it.version || "—") + "</td><td>" + ((r.sizes || []).length || "—") + "</td><td>" + badge(lvl, lvl.toUpperCase()) +
				"</td><td>" + fHtml + detail + "</td></tr>");
		});
		var done = counts.pass + counts.warn + counts.fail;
		var summary = "<p><span class='pill'>" + done + " page(s) audited</span>" +
			"<span class='pill'>" + badge("pass", counts.pass + " OK") + "</span>" +
			"<span class='pill'>" + badge("warn", counts.warn + " to review") + "</span>" +
			"<span class='pill'>" + badge("fail", counts.fail + " with problems") + "</span></p>";
		var table = rows.length ? "<table><tr><th>Client</th><th>Brand</th><th>ISI</th><th>Status</th><th>Version</th><th>Sizes</th><th>Result</th><th>Findings</th></tr>" + rows.join("") + "</table>" :
			"<p class='muted'>" + (done ? "No pages with issues." : "Results appear here as each page is audited.") + "</p>";
		return { summary: summary, table: table };
	}

	function renderResults() {
		var h = resultsHtml(false);
		$("summary").innerHTML = h.summary;
		$("results").innerHTML = h.table;
	}
	$("fResult").addEventListener("change", renderResults);

	function download(blob, name) {
		var url = URL.createObjectURL(blob);
		chrome.downloads.download({ url: url, filename: name, saveAs: false, conflictAction: "uniquify" }, function () {
			setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
		});
	}

	function stamp() {
		var d = new Date();
		return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
	}

	$("dlHtml").addEventListener("click", function () {
		fetch(chrome.runtime.getURL("audit.css")).then(function (r) { return r.text(); }).then(function (css) {
			var h = resultsHtml(true);
			var html = "<!doctype html><meta charset='utf-8'><title>Tray rendering audit " + stamp() + "</title><style>" + css +
				" body{padding:16px;background:#fff}</style><h1 style='color:#094548'>Tray rendering audit</h1><p class='muted'>" + esc(new Date().toLocaleString()) +
				" · Pixel self-check: " + ($("pixel").checked ? "on" : "off") + "</p>" + h.summary + h.table;
			download(new Blob([html], { type: "text/html" }), "tray-audit_" + stamp() + ".html");
		});
	});

	$("dlCsv").addEventListener("click", function () {
		var q = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
		var lines = [["Client", "Brand", "ISI", "Status", "Version", "Sizes", "Result", "Findings", "URL"].join(",")];
		items.forEach(function (it, i) {
			var r = results[i];
			if (!r) return;
			var f = findings(r).map(function (x) { return x.level.toUpperCase() + ": " + x.text + (x.sizes.length ? " (" + x.sizes.join(" ") + ")" : ""); }).join(" | ");
			lines.push([it.client, it.brand, it.isi, it.status, r.version || it.version, (r.sizes || []).length, pageLevel(r).toUpperCase(), f, pageUrl(it)].map(q).join(","));
		});
		download(new Blob([lines.join("\n")], { type: "text/csv" }), "tray-audit_" + stamp() + ".csv");
	});

	/* ------------------- remember the last run ------------------- */
	function saveLast() {
		var slim = {};
		Object.keys(results).forEach(function (k) {
			var r = results[k];
			slim[k] = { error: r.error, version: r.version, sizes: (r.sizes || []).map(function (s) {
				return { size: s.size, level: s.level, issues: s.issues, pixel: s.pixel, note: s.note, error: s.error };
			}) };
		});
		try { chrome.storage.local.set({ lastAudit: { date: new Date().toISOString(), base: $("base").value, items: items, results: slim } }); } catch (e) {}
	}

	try {
		chrome.storage.local.get("lastAudit", function (st) {
			var last = st && st.lastAudit;
			if (!last || !last.items) return;
			$("last").innerHTML = "Last audit: " + esc(new Date(last.date).toLocaleString()) + " (" + Object.keys(last.results).length + " pages). ";
			var b = document.createElement("button");
			b.textContent = "Show last results";
			b.addEventListener("click", function () {
				if (!$("base").value) $("base").value = last.base || "";
				setItems(last.items);
				results = last.results;
				$("resultCard").hidden = false;
				renderResults();
			});
			$("last").appendChild(b);
		});
	} catch (e) {}
})();
