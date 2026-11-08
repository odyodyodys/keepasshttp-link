// Settings page. Plain DOM, no library. Text from storage or KeePass is
// always inserted with textContent, never as HTML.
//
// The status card and the Databases list render from one derived state
// (A, A2, B, B-wait, B2, B3, C), see input/design-settings/SPEC.md section 3.
// The page polls the connection while it is visible (never with the
// KeePass unlock prompt) and never sees the pairing keys.
//
// Every option is a ".opt" element with data attributes:
//   data-setting  key in the settings object
//   data-type     bool | int | seconds | offset-toggle
//   data-invert   (bool) the checkbox shows the opposite of the stored value
//   data-default  stored default (as stored: "true", "7500", "-1", ...)
//   data-min / data-max   allowed stored values (int, seconds: milliseconds)
//   data-parent   key of a bool option; this option is disabled while it is off
//   data-parent-offset    this option is disabled while blinkMinTimeout < 0
// Numbers are stored as strings, as the older versions did. Times are stored
// in milliseconds and shown in seconds.

var options = options || {};

options.$ = function(selector, root) {
	return (root || document).querySelector(selector);
};
options.$$ = function(selector, root) {
	return Array.prototype.slice.call((root || document).querySelectorAll(selector));
};

// The background reloads the settings only after they are stored (before,
// both ran at the same time and the background could read old values).
options.saveSettings = function() {
	return browser.storage.local.set({'settings': options.settings}).then(function() {
		return browser.runtime.sendMessage({ action: 'load_settings' });
	});
};
options.saveSettingsPromise = options.saveSettings;

// ---------------------------------------------------------------- tabs

// Tabs are buttons (role tab) with arrow-key navigation. The address keeps
// the tab (#filling, ...), so a reload stays on it.
options.initTabs = function() {
	var tabs = options.$$(".tabs [role=tab]");
	var show = function(tab, focus) {
		tabs.forEach(function(t) {
			var on = (t === tab);
			t.setAttribute("aria-selected", on ? "true" : "false");
			t.tabIndex = on ? 0 : -1;
			document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
		});
		if(focus) {
			tab.focus();
		}
	};
	var byName = function(name) {
		return tabs.filter(function(t) { return t.dataset.tab === name; })[0];
	};
	tabs.forEach(function(t, i) {
		t.addEventListener("click", function() {
			show(t, false);
			history.replaceState(null, "", "#" + t.dataset.tab);
		});
		t.addEventListener("keydown", function(e) {
			var next = null;
			if(e.key === "ArrowRight") { next = tabs[(i + 1) % tabs.length]; }
			else if(e.key === "ArrowLeft") { next = tabs[(i - 1 + tabs.length) % tabs.length]; }
			else if(e.key === "Home") { next = tabs[0]; }
			else if(e.key === "End") { next = tabs[tabs.length - 1]; }
			if(next) {
				e.preventDefault();
				show(next, true);
				history.replaceState(null, "", "#" + next.dataset.tab);
			}
		});
	});
	show(byName(location.hash.substring(1)) || tabs[0], false);
};

// ---------------------------------------------------------------- icons

// Inline SVG icons (24 x 24, stroke = currentColor). Decorative: the text
// next to them carries the meaning.
options.ICONS = {
	"x-circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
	"lock": '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
	"alert-circle": '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
	"hourglass": '<path d="M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4"/>',
	"check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
	"info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
	"check": '<path d="M5 12l4 4 10-10"/>',
	"x": '<path d="M6 6l12 12M18 6L6 18"/>',
	"external": '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'
};

// The markup above is fixed text from this file, never data from storage or KeePass.
options.icon = function(name, size, strokeWidth) {
	var ns = "http://www.w3.org/2000/svg";
	var svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", strokeWidth || 2);
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	var parsed = new DOMParser().parseFromString('<svg xmlns="' + ns + '">' + options.ICONS[name] + "</svg>", "image/svg+xml");
	Array.prototype.slice.call(parsed.documentElement.childNodes).forEach(function(n) {
		svg.appendChild(document.importNode(n, true));
	});
	return svg;
};

options.setIcon = function(container, name, size, strokeWidth) {
	container.textContent = "";
	if(name) {
		container.appendChild(options.icon(name, size, strokeWidth));
	}
};

// ---------------------------------------------------------------- text helpers

// A database name chip (key name from the key ring, inserted as text).
options.chip = function(name, kind) {
	var span = document.createElement("span");
	span.className = "chip " + (kind || "");
	span.textContent = name;
	return span;
};

// Fill an element from parts: strings become text, nodes are appended.
options.fill = function(el, parts) {
	el.textContent = "";
	parts.forEach(function(p) {
		el.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
	});
};

options.isToday = function(ms) {
	var d = new Date(ms);
	var now = new Date();
	return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

// "7 Nov 2026": day, short month name in the browser locale, year.
options.formatDate = function(ms) {
	var d = new Date(ms);
	var month;
	try {
		month = new Intl.DateTimeFormat(navigator.language || undefined, { month: "short" }).format(d);
	} catch(e) {
		month = new Intl.DateTimeFormat("en", { month: "short" }).format(d);
	}
	return d.getDate() + " " + month.replace(/\.$/, "") + " " + d.getFullYear();
};

// ---------------------------------------------------------------- state

options.keyRing = {};       // from the background, without keys
options.conn = null;        // last connection reply that was not "busy"
options.pairing = null;     // { from: state } while this page waits for a pairing
options.failure = null;     // { state, closeHint } after a pairing that did not finish
options.unlocking = false;  // "Unlock in KeePass" is waiting
options.checking = false;   // a connection check is waiting
options.connSettingsOpen = false; // card: connection settings opened by the user
options.detailsOpen = false;
options.POLL_MS = 2500;
options.pollTimer = null;

options.ringIsEmpty = function() {
	return Object.keys(options.keyRing).length === 0;
};

// SPEC section 3: one state from the last reply, in this order.
options.deriveState = function(s) {
	if(!s || !s.pluginAvailable) {
		return "A";
	}
	if(s.databaseClosed) {
		return "A2";
	}
	if(s.pairingInFlight || options.pairing) {
		return "B-wait";
	}
	var entry = s.hash ? options.keyRing[s.hash] : null;
	if(entry && entry.status === "lost") {
		return "B3";
	}
	if(entry && s.associated) {
		return "C";
	}
	if(entry) {
		// Known database, key not lost, but not accepted: the answer failed
		// the integrity check, or the key ring is being reloaded.
		return s.integrityFailed ? "E" : "B3";
	}
	return options.ringIsEmpty() ? "B" : "B2";
};

// The most recently used entry (B2: "switch KeePass back to ...").
options.recentEntry = function() {
	var best = null;
	Object.keys(options.keyRing).forEach(function(hash) {
		var e = options.keyRing[hash];
		var t = e.lastUsedAt || e.addedAt || 0;
		if(!best || t > best.t) {
			best = { t: t, entry: e };
		}
	});
	return best ? best.entry : null;
};

options.port = function() {
	return (options.conn && options.conn.port) || Number(options.settings.port) || 19455;
};

// ---------------------------------------------------------------- status card

options.STATE_ICON = {
	"A": "x-circle", "A2": "lock", "B": "alert-circle", "B2": "alert-circle",
	"B-wait": "hourglass", "B3": "alert-circle", "C": "check-circle", "E": "alert-circle"
};

options.renderCard = function() {
	var s = options.conn;
	var state = options.deriveState(s);
	var activeEntry = (s && s.hash) ? options.keyRing[s.hash] : null;
	var name = activeEntry ? String(activeEntry.id) : "";
	var firstRun = options.ringIsEmpty();
	var port = String(options.port());

	// A failed pairing is shown until the state changes.
	if(options.failure && options.failure.state !== state) {
		options.failure = null;
	}
	var failure = options.failure;

	var card = document.getElementById("status-card");
	card.hidden = false;
	card.dataset.state = state;

	// ---- diagram
	var link = document.getElementById("d-link");
	link.className = "d-link " + (state === "A" ? "off" : "on");
	var linkLabel = document.getElementById("d-link-label");
	linkLabel.hidden = !(state === "A" || state === "B-wait");
	linkLabel.className = "d-link-label " + (state === "A" ? "off" : "wait");
	if(state === "A") {
		var labelIcon = document.createElement("span");
		labelIcon.className = "d-link-icon";
		labelIcon.appendChild(options.icon("x-circle", 14, 2.2));
		options.fill(linkLabel, [labelIcon, "not answering"]);
	} else if(state === "B-wait") {
		options.fill(linkLabel, ["asking…"]);
	}

	var tile = document.getElementById("d-tile");
	var tiles = {
		"A2": ["Database", "locked"],
		"B": ["Database", "no access yet"],
		"B2": ["Active database", "no access yet"],
		"B-wait": ["Database", "confirm in KeePass"],
		"B3": [name, "access lost"],
		"C": [name, "in use"],
		"E": ["Database", "check failed"]
	};
	tile.hidden = !tiles[state];
	if(tiles[state]) {
		tile.className = "d-tile " + (state === "C" ? "ok" : (state === "B-wait" ? "wait" : "attention"));
		options.setIcon(options.$(".d-tile-icon", tile), options.STATE_ICON[state], 18);
		options.$(".d-tile-name", tile).textContent = tiles[state][0];
		options.$(".d-tile-state", tile).textContent = tiles[state][1];
	}

	var caption = document.getElementById("d-caption");
	var recent = options.recentEntry();
	caption.hidden = !(state === "B2" && recent);
	if(state === "B2" && recent) {
		options.$(".chip", caption).textContent = String(recent.id);
	}

	// ---- sentence
	var icon = document.getElementById("state-icon");
	icon.className = "state-icon " + (state === "C" ? "ok" : "attention");
	options.setIcon(icon, options.STATE_ICON[state], 20);

	var headline = document.getElementById("headline");
	var sub = null;
	if(state === "A") {
		options.fill(headline, ["KeePass is not answering."]);
		sub = ["Firefox cannot reach the KeePassHttp plugin on port " + port + ". Usually KeePass is not running, or the plugin is not installed in it. Start KeePass and this page updates by itself. Until then, no passwords can be filled or saved."];
	} else if(state === "A2") {
		options.fill(headline, ["KeePass is running, but the database is locked."]);
		sub = ["Unlock it to continue. The unlock window may open behind Firefox."];
	} else if(state === "B") {
		options.fill(headline, ["KeePass is running and a database is open. Firefox does not have access to it yet."]);
		sub = ["KeePass will ask you to confirm and to type a Key Name. Type the database's name, for example Work. That is the name you will see here."];
	} else if(state === "B-wait") {
		options.fill(headline, ["Waiting for KeePass…"]);
		sub = ["KeePass opened a small window. It may be behind Firefox. Type a Key Name, for example Work, and confirm."];
	} else if(state === "B2") {
		options.fill(headline, ["The database open in KeePass is not set up for Firefox."]);
		sub = recent
			? ["Give Firefox access to it, or switch KeePass back to ", options.chip(String(recent.id), "chip-text"), "."]
			: ["Give Firefox access to it."];
	} else if(state === "B3") {
		options.fill(headline, ["Firefox lost access to ", options.chip(name, "chip-headline"), "."]);
		sub = (activeEntry && activeEntry.lostReason === "weak")
			? ["Its key used an older, weaker format and was retired. Your settings for " + name + " are kept."]
			: ["KeePass no longer recognises the key Firefox stored for it. This happens when the KeePassHttp entry was changed or removed in KeePass, or when a copy of the database replaced it. Your settings for " + name + " are kept."];
	} else if(state === "C") {
		options.fill(headline, ["Connected to ", options.chip(name, "chip-headline"), "."]);
	} else if(state === "E") {
		options.fill(headline, ["KeePass answered, but the answer failed the security check."]);
		sub = ["Update the KeePassHttp plugin to 2.3 or newer. This page updates by itself."];
	}

	var failureLine = document.getElementById("failure-line");
	failureLine.hidden = !failure;
	if(failure) {
		failureLine.textContent = "KeePass did not confirm. Nothing changed." +
			(failure.closeHint ? " If the KeePass window is still open, close it." : "");
	}

	var subline = document.getElementById("subline");
	subline.hidden = !sub;
	if(sub) {
		options.fill(subline, sub);
	}

	// ---- Details (C only)
	var detailsToggle = document.getElementById("details-toggle");
	var details = document.getElementById("details-line");
	detailsToggle.hidden = (state !== "C");
	var showDetails = (state === "C" && options.detailsOpen);
	detailsToggle.textContent = showDetails ? "Details ▾" : "Details ▸";
	detailsToggle.setAttribute("aria-expanded", showDetails ? "true" : "false");
	details.hidden = !showDetails;
	details.textContent = "Port " + port + " · KeePassHttp " + ((s && s.version) || "unknown") +
		" (tested with " + ((s && s.testedWith) || "2.3.1.0") + ")";

	// ---- one-time note (C, after a pairing)
	document.getElementById("first-fill-note").hidden = !(state === "C" && activeEntry && activeEntry.firstFillNote);

	// ---- the one action
	var action = document.getElementById("card-action");
	var label = null;
	var kind = "primary";
	if(state === "A2") { label = "Unlock in KeePass"; }
	else if(state === "B" || state === "B2") { label = failure ? "Try again" : "Give Firefox access"; }
	else if(state === "B3") { label = failure ? "Try again" : "Give access again"; }
	else if(state === "B-wait") { label = "Cancel"; kind = "secondary"; }
	action.hidden = !label;
	if(label) {
		action.textContent = label;
		action.className = kind + " card-action";
		action.dataset.action = state;
		action.disabled = (state === "A2" && options.unlocking) ||
			(state === "B-wait" && !options.pairing && !(s && s.pairingInFlight));
	}

	// ---- What you need (A and B, first run only)
	var need = document.getElementById("need");
	need.hidden = !(firstRun && (state === "A" || state === "B"));
	if(!need.hidden) {
		var ticked = (state === "B");
		options.$$(".need-row", need).forEach(function(row) {
			var n = row.dataset.row;
			var on = ticked && n !== "3";
			row.classList.toggle("done", on);
			var tick = options.$(".tick", row);
			tick.classList.toggle("on", on);
			options.setIcon(tick, on ? "check" : null, 12, 3);
			var text = options.$(".need-text", row);
			if(n === "1") {
				if(on) {
					options.fill(text, ["KeePass 2.x with the KeePassHttp plugin by alan-null, 2.3 or newer."]);
				} else {
					var b = document.createElement("b");
					b.textContent = "KeePassHttp";
					var a = document.createElement("a");
					a.href = "https://github.com/alan-null/keepasshttp/releases";
					a.target = "_blank";
					a.rel = "noopener noreferrer";
					a.textContent = "Get the plugin";
					options.fill(text, ["KeePass 2.x with the ", b, " plugin by alan-null, 2.3 or newer. ", a]);
				}
			}
			if(n === "3") {
				text.textContent = "Firefox given access to that database. " +
					(state === "B" ? "Use the button above." : "This last step happens on this page.");
			}
		});
	}

	// ---- Connection settings (A only): closed until the user opens them
	var settingsOpen = (state === "A") && options.connSettingsOpen;
	var settingsToggle = document.getElementById("help-toggle-row");
	settingsToggle.textContent = settingsOpen ? "Connection settings ▾" : "Connection settings ▸";
	settingsToggle.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
	document.getElementById("help").hidden = (state !== "A");
	document.getElementById("help-body").hidden = !settingsOpen;

	// ---- behaviour tabs: notice while not connected
	options.$$("[data-notice]").forEach(function(n) {
		n.hidden = (state === "C");
	});

	options.state = state;
};

// ---------------------------------------------------------------- databases list

// SPEC 6.3: status word of a row.
options.statusWord = function(hash, state) {
	var s = options.conn;
	if(state === "A" || state === "A2" || !s) {
		return null;
	}
	if(hash === s.hash) {
		if(state === "C") { return { text: "In use now", kind: "ok" }; }
		if(state === "B3") { return { text: "Access lost", kind: "attention" }; }
		return null;
	}
	return { text: "Not active in KeePass", kind: "" };
};

options.renderRowMeta = function(meta, hash, state) {
	var entry = options.keyRing[hash];
	var parts = [];
	var word = options.statusWord(hash, state);
	if(word) {
		var w = document.createElement("span");
		w.className = "status-word " + word.kind;
		w.textContent = word.text;
		parts.push(w);
	}
	parts.push(entry.addedAt ? "Added on " + options.formatDate(entry.addedAt) : "Added before this version");
	if(entry.lastUsedAt) {
		parts.push("Last used " + (options.isToday(entry.lastUsedAt) ? "today" : options.formatDate(entry.lastUsedAt)));
	}
	var out = [];
	parts.forEach(function(p, i) {
		if(i > 0) {
			out.push(" · ");
		}
		out.push(p);
	});
	options.fill(meta, out);
};

// Rows are kept per hash and updated in place. While a description field has
// the focus, rows are neither added, removed nor moved.
options.renderList = function() {
	var state = options.deriveState(options.conn);
	var hashes = Object.keys(options.keyRing);
	var list = document.getElementById("db-list");
	var rows = document.getElementById("db-rows");
	var empty = document.getElementById("db-empty");
	var more = document.getElementById("db-more");

	// Before the first answer the state is unknown: no empty-list sentence yet.
	empty.hidden = hashes.length > 0 || !options.conn;
	list.hidden = hashes.length === 0;
	more.hidden = hashes.length === 0;
	if(hashes.length === 0) {
		empty.textContent = (state === "A") ? "No database set up yet. Finish the steps above."
			: (state === "B") ? "No database set up yet. Use the button above."
			: "No database set up yet.";
	}

	var activeHash = (options.conn && options.conn.hash) || null;
	hashes.sort(function(a, b) {
		if(state === "C") {
			if(a === activeHash) { return -1; }
			if(b === activeHash) { return 1; }
		}
		var ea = options.keyRing[a];
		var eb = options.keyRing[b];
		return (eb.lastUsedAt || 0) - (ea.lastUsedAt || 0) || (eb.addedAt || 0) - (ea.addedAt || 0);
	});

	var editing = rows.contains(document.activeElement) && document.activeElement.matches("input.db-desc");
	var existing = {};
	options.$$("li.db-row", rows).forEach(function(li) {
		existing[li.dataset.hash] = li;
	});

	if(!editing) {
		Object.keys(existing).forEach(function(hash) {
			if(!(hash in options.keyRing)) {
				existing[hash].remove();
				delete existing[hash];
			}
		});
	}

	hashes.forEach(function(hash) {
		var li = existing[hash];
		if(!li) {
			if(editing) {
				return;
			}
			li = options.createRow(hash);
		}
		options.updateRow(li, hash, state);
		if(!editing) {
			rows.appendChild(li); // keeps the order above
		}
	});
	options.pendingList = editing;
};

options.createRow = function(hash) {
	var li = document.getElementById("row-database").content.firstElementChild.cloneNode(true);
	li.dataset.hash = hash;
	var input = options.$("input.db-desc", li);
	var save = function() {
		var entry = options.keyRing[hash];
		if(!entry) {
			return;
		}
		var v = input.value.trim();
		input.value = v;
		if(v === (entry.description || "")) {
			return;
		}
		entry.description = v;
		browser.runtime.sendMessage({ action: "update_key_entry", args: [hash, { description: v }] });
	};
	input.addEventListener("change", save);
	input.addEventListener("keydown", function(e) {
		if(e.key === "Enter") {
			e.preventDefault();
			save();
			input.blur();
		}
	});
	input.addEventListener("blur", function() {
		// A list update was held back while the field had the focus.
		setTimeout(function() {
			if(options.pendingList) {
				options.renderList();
			}
		}, 0);
	});
	options.$("button.db-again", li).addEventListener("click", function() {
		options.startPairing(hash);
	});
	options.$("button.db-remove", li).addEventListener("click", function() {
		options.confirmRemove(hash);
	});
	return li;
};

options.updateRow = function(li, hash, state) {
	var entry = options.keyRing[hash];
	var name = String(entry.id);
	options.$(".chip", li).textContent = name;
	options.renderRowMeta(options.$(".db-meta", li), hash, state);
	var input = options.$("input.db-desc", li);
	input.setAttribute("aria-label", "Description for " + name);
	if(document.activeElement !== input) {
		input.value = entry.description || "";
	}
	var word = options.statusWord(hash, state);
	var again = options.$("button.db-again", li);
	again.hidden = !(word && word.text === "Access lost");
	again.disabled = !!options.pairing;
};

options.confirmRemove = function(hash) {
	var entry = options.keyRing[hash];
	if(!entry) {
		return;
	}
	var dialog = document.getElementById("dialogRemoveDatabase");
	options.$(".name", dialog).textContent = String(entry.id);
	dialog.returnValue = "";
	var onClose = function() {
		dialog.removeEventListener("close", onClose);
		if(dialog.returnValue !== "yes") {
			return;
		}
		browser.runtime.sendMessage({ action: "remove_key", args: [hash] }).then(function() {
			return options.reloadKeyRing();
		}).then(function() {
			options.poll(true);
		});
	};
	dialog.addEventListener("close", onClose);
	dialog.showModal();
};

options.render = function() {
	options.renderCard();
	options.renderList();
};

// ---------------------------------------------------------------- talking to the background

options.reloadKeyRing = function() {
	return browser.runtime.sendMessage({ action: "load_keyring" }).then(function(ring) {
		options.keyRing = ring || {};
		options.render();
	});
};

// A reply that says "busy" (KeePass did not answer in time, for example a
// KeePass dialog is open) keeps the last state.
options.applyStatus = function(s) {
	if(s && s.lost) {
		return; // no answer at all: nothing new is known
	}
	if(s && s.busy && options.conn) {
		if(options.conn.pairingInFlight !== s.pairingInFlight) {
			options.conn.pairingInFlight = s.pairingInFlight;
			options.render();
		}
		return;
	}
	options.conn = s || { pluginAvailable: false };
	var about = document.querySelector("#tab-about em.versionKPH");
	if(about) {
		about.textContent = (s && s.version) || "unknown";
	}
	options.render();
};

// SPEC section 8: one check at a time, never with TriggerUnlock, paused while
// the page is hidden. force: run now even if a timer is set.
options.poll = function(force) {
	clearTimeout(options.pollTimer);
	options.pollTimer = null;
	if(document.hidden) {
		return;
	}
	if(options.checking || options.unlocking || options.pairing) {
		options.schedulePoll();
		return;
	}
	options.checking = true;
	// The background answers within its own time limit. If the answer is lost
	// anyway, the next check must still run: give up after POLL_LIMIT_MS and
	// keep the last state.
	var limit = new Promise(function(resolve) {
		setTimeout(function() { resolve({ busy: true, lost: true }); }, options.POLL_LIMIT_MS);
	});
	Promise.race([browser.runtime.sendMessage({ action: "check_connection", args: [false] }), limit]).then(function(s) {
		options.applyStatus(s);
	}, function() {
		options.applyStatus(null);
	}).then(function() {
		options.checking = false;
		options.schedulePoll();
	});
};
options.POLL_LIMIT_MS = 15 * 1000;

options.schedulePoll = function() {
	clearTimeout(options.pollTimer);
	if(!document.hidden) {
		options.pollTimer = setTimeout(options.poll, options.POLL_MS);
	}
};

// "Give Firefox access", "Give access again" (hash of the known database), "Try again".
options.startPairing = function(expectedHash) {
	if(options.pairing) {
		return;
	}
	var from = options.deriveState(options.conn);
	options.failure = null;
	options.pairing = { from: from };
	options.render();
	browser.runtime.sendMessage({ action: "associate", args: expectedHash ? [expectedHash] : [] }).then(function(r) {
		return r;
	}, function() {
		return { ok: false, reason: "error" };
	}).then(function(r) {
		options.pairing = null;
		var reason = r ? r.reason : "error";
		if(r && !r.ok && (reason === "refused" || reason === "cancelled" || reason === "timeout")) {
			options.failure = { state: from, closeHint: reason !== "refused" };
		}
		if(options.conn) {
			options.conn.pairingInFlight = false;
		}
		return options.reloadKeyRing();
	}).then(function() {
		options.poll(true);
	});
};

options.initCard = function() {
	document.getElementById("card-action").addEventListener("click", function() {
		var btn = this;
		var state = btn.dataset.action;
		if(state === "A2") {
			// The only request that may show the KeePass unlock window.
			options.unlocking = true;
			btn.disabled = true;
			browser.runtime.sendMessage({ action: "check_connection", args: [true] }).then(function(s) {
				options.unlocking = false;
				options.applyStatus(s);
			}, function() {
				options.unlocking = false;
				options.render();
			});
		}
		else if(state === "B-wait") {
			btn.disabled = true;
			browser.runtime.sendMessage({ action: "cancel_associate" });
		}
		else if(state === "B3") {
			options.startPairing(options.conn && options.conn.hash);
		}
		else if(state === "B" || state === "B2") {
			options.startPairing(null);
		}
	});

	document.getElementById("details-toggle").addEventListener("click", function() {
		options.detailsOpen = !options.detailsOpen;
		options.renderCard();
	});

	document.getElementById("help-toggle-row").addEventListener("click", function() {
		options.connSettingsOpen = !options.connSettingsOpen;
		options.renderCard();
	});

	document.getElementById("advanced-toggle").addEventListener("click", function() {
		var body = document.getElementById("advanced");
		body.hidden = !body.hidden;
		this.textContent = body.hidden ? "Connection settings ▸" : "Connection settings ▾";
		this.setAttribute("aria-expanded", body.hidden ? "false" : "true");
	});

	document.getElementById("note-dismiss").addEventListener("click", function() {
		var hash = options.conn && options.conn.hash;
		if(hash && options.keyRing[hash]) {
			options.keyRing[hash].firstFillNote = false;
			options.renderCard();
			browser.runtime.sendMessage({ action: "update_key_entry", args: [hash, { dismissFirstFillNote: true }] });
		}
	});

	options.setIcon(options.$("#first-fill-note .note-icon"), "info", 18);
	options.$$("[data-notice] .notice-icon").forEach(function(el) {
		options.setIcon(el, "alert-circle", 16);
	});

	options.initPortControls();
	options.initPopovers();

	// The key ring changed elsewhere (pairing from the toolbar popup, "last
	// used" after a fill, a key marked lost): load it again.
	var ringTimer = null;
	browser.storage.onChanged.addListener(function(changes, area) {
		if(area !== "local" || !changes.keyRing) {
			return;
		}
		clearTimeout(ringTimer);
		ringTimer = setTimeout(options.reloadKeyRing, 100);
	});

	document.addEventListener("visibilitychange", function() {
		if(document.hidden) {
			clearTimeout(options.pollTimer);
			options.pollTimer = null;
		} else {
			options.poll(true);
		}
	});
	window.addEventListener("pagehide", function() {
		clearTimeout(options.pollTimer);
		options.pollTimer = null;
	});
};

// Diagram: the KeePassHttp-Link and plugin boxes open a short info popover.
// One at a time. Closes with its close button, Escape, or a click outside;
// focus then goes back to the box.
options.initPopovers = function() {
	var pairs = options.$$(".diagram button.d-module").map(function(btn) {
		return { btn: btn, pop: document.getElementById(btn.getAttribute("aria-controls")) };
	});
	var close = function(p, focus) {
		if(p.pop.hidden) {
			return;
		}
		p.pop.hidden = true;
		p.btn.setAttribute("aria-expanded", "false");
		if(focus) {
			p.btn.focus();
		}
	};
	var open = function(p) {
		pairs.forEach(function(o) {
			if(o !== p) {
				close(o, false);
			}
		});
		p.pop.hidden = false;
		p.btn.setAttribute("aria-expanded", "true");
		options.$(".pop-close", p.pop).focus();
	};
	pairs.forEach(function(p) {
		options.setIcon(options.$(".d-badge", p.btn), "info", 16);
		options.setIcon(options.$(".pop-close", p.pop), "x", 14);
		options.$(".pop-link", p.pop).appendChild(options.icon("external", 14));
		p.btn.addEventListener("click", function() {
			if(p.pop.hidden) {
				open(p);
			} else {
				close(p, true);
			}
		});
		options.$(".pop-close", p.pop).addEventListener("click", function() {
			close(p, true);
		});
	});
	document.addEventListener("click", function(e) {
		pairs.forEach(function(p) {
			if(!p.pop.hidden && !p.pop.contains(e.target) && !p.btn.contains(e.target)) {
				close(p, false);
			}
		});
	});
	document.addEventListener("keydown", function(e) {
		if(e.key !== "Escape") {
			return;
		}
		pairs.forEach(function(p) {
			close(p, p.pop.contains(document.activeElement) || p.btn === document.activeElement);
		});
	});
};

// Port: the same control in Help (state A) and in Advanced (Databases tab).
options.initPortControls = function() {
	var inputs = options.$$("#card-port, #advanced-port");
	var show = function() {
		inputs.forEach(function(i) {
			if(document.activeElement !== i) {
				i.value = String(options.settings.port || 19455);
			}
		});
	};
	show();
	options.$$(".port-row").forEach(function(row) {
		var input = options.$("input", row);
		var status = options.$(".port-status", row);
		var use = function() {
			var text = String(input.value).trim();
			var port = /^[0-9]{1,5}$/.test(text) ? parseInt(text, 10) : NaN;
			if(!(port >= 1025 && port <= 65535)) {
				status.textContent = "Not valid, nothing saved. Allowed: 1025 to 65535.";
				status.className = "port-status error";
				return;
			}
			status.textContent = "";
			status.className = "port-status";
			options.settings.port = String(port);
			options.saveSettings().then(function() {
				show();
				options.poll(true);
			});
		};
		options.$("button.port-save", row).addEventListener("click", use);
		input.addEventListener("keydown", function(e) {
			if(e.key === "Enter") {
				e.preventDefault();
				use();
			}
		});
	});
};

// (i) buttons open the long explanation under the option.
options.initInfoButtons = function() {
	options.$$("button.info").forEach(function(btn) {
		var panel = document.getElementById(btn.getAttribute("aria-controls"));
		if(!panel) {
			return;
		}
		btn.addEventListener("click", function() {
			var open = panel.hidden;
			panel.hidden = !open;
			btn.setAttribute("aria-expanded", open ? "true" : "false");
			btn.classList.toggle("open", open);
		});
	});
};

// ---------------------------------------------------------------- options

options.formatSeconds = function(ms) {
	var s = Math.round(Number(ms) / 100) / 10;
	return String(s);
};

// Text under the control: default, allowed range, and a Reset link when the
// value differs from the default.
options.renderMeta = function(opt) {
	var meta = options.$(".opt-meta", opt);
	if(!meta) {
		return;
	}
	var type = opt.dataset.type;
	var def = opt.dataset.default;
	var current = options.settings[opt.dataset.setting];
	var parts = [];
	var isDefault;

	if(type === "bool") {
		var defOn = (def === "true");
		parts.push("Default: " + ((opt.dataset.invert ? !defOn : defOn) ? "on" : "off"));
		isDefault = (!!current === defOn);
	}
	else if(type === "offset-toggle") {
		parts.push("Default: off");
		isDefault = !(Number(current) >= 0);
	}
	else if(type === "seconds") {
		parts.push("Default: " + options.formatSeconds(def) + " s");
		parts.push("Allowed: " + options.formatSeconds(opt.dataset.min) + " to " + options.formatSeconds(opt.dataset.max) + " s");
		isDefault = (String(current) === String(def));
	}
	else {
		parts.push("Default: " + def);
		parts.push("Allowed: " + opt.dataset.min + " to " + opt.dataset.max);
		isDefault = (String(current) === String(def));
	}

	meta.textContent = "";
	parts.forEach(function(p, i) {
		if(i > 0) {
			meta.appendChild(document.createTextNode(" · "));
		}
		meta.appendChild(document.createTextNode(p));
	});
	if(!isDefault) {
		meta.appendChild(document.createTextNode(" · "));
		var reset = document.createElement("a");
		reset.href = "#";
		reset.className = "reset";
		reset.textContent = "Reset to default";
		reset.addEventListener("click", function(e) {
			e.preventDefault();
			options.store(opt, (type === "bool") ? (def === "true") : def);
		});
		meta.appendChild(reset);
	}
};

// Show the stored value in the control.
options.renderOpt = function(opt) {
	var type = opt.dataset.type;
	var key = opt.dataset.setting;
	var value = options.settings[key];
	var input = options.$("input", opt);

	if(type === "bool") {
		var on = (value === true);
		input.checked = opt.dataset.invert ? !on : on;
	}
	else if(type === "offset-toggle") {
		input.checked = (Number(value) >= 0);
	}
	else if(type === "seconds") {
		var ms = Number(value);
		if(!isFinite(ms) || ms < 0) {
			ms = Number(opt.dataset.default);
		}
		input.value = options.formatSeconds(ms);
	}
	else {
		input.value = (value === undefined) ? opt.dataset.default : String(value);
	}
	opt.classList.remove("error");
	options.renderMeta(opt);
	options.renderEnabled(opt);
};

// Child options are disabled while their parent is off.
options.renderEnabled = function(opt) {
	var enabled = true;
	if(opt.dataset.parent) {
		enabled = (options.settings[opt.dataset.parent] === true);
	}
	if(opt.dataset.parentOffset) {
		enabled = (Number(options.settings.blinkMinTimeout) >= 0);
	}
	opt.classList.toggle("disabled", !enabled);
	// The (i) button stays usable, so the explanation can still be read.
	options.$$("input, a.reset", opt).forEach(function(el) {
		if(el.tagName === "A") {
			el.hidden = !enabled;
		} else {
			el.disabled = !enabled;
		}
	});
};

options.renderAll = function() {
	options.$$(".opt[data-setting]").forEach(options.renderOpt);
};

// Short "Saved" or error text next to the option.
options.flash = function(opt, text, kind) {
	var head = options.$(".opt-head", opt);
	var state = options.$(".save-state", head);
	if(!state) {
		state = document.createElement("span");
		state.className = "save-state";
		state.setAttribute("aria-live", "polite");
		head.appendChild(state);
	}
	clearTimeout(opt._flashTimer);
	state.textContent = text;
	state.className = "save-state " + (kind || "");
	opt.classList.toggle("error", kind === "error");
	if(kind !== "error") {
		opt._flashTimer = setTimeout(function() {
			state.textContent = "";
		}, 2500);
	}
};

// Store a value (as stored, e.g. "7500" or true), save, then redraw every
// option that shows this key or depends on it.
options.store = function(opt, value) {
	var key = opt.dataset.setting;
	options.settings[key] = value;
	return options.saveSettings().then(function() {
		if(key === "autoFillAndSend") {
			browser.runtime.sendMessage({ action: "init_http_auth" });
		}
		options.$$(".opt[data-setting]").forEach(function(o) {
			if(o.dataset.setting === key || o.dataset.parent === key || (o.dataset.parentOffset && key === "blinkMinTimeout")) {
				options.renderOpt(o);
			}
		});
		options.flash(opt, "Saved", "ok");
	});
};

options.parseNumber = function(opt, text) {
	text = String(text).trim().replace(",", ".");
	if(text === "") {
		return null;
	}
	var min = Number(opt.dataset.min);
	var max = Number(opt.dataset.max);
	var n;
	if(opt.dataset.type === "seconds") {
		if(!/^[0-9]+([.][0-9]+)?$/.test(text)) {
			return null;
		}
		n = Math.round(parseFloat(text) * 1000);
	}
	else {
		if(!/^-?[0-9]{1,9}$/.test(text)) {
			return null;
		}
		n = parseInt(text, 10);
	}
	return (n < min || n > max) ? null : String(n);
};

options.bindOpt = function(opt) {
	var type = opt.dataset.type;
	var input = options.$("input", opt);
	if(!input) {
		return;
	}
	if(type === "bool") {
		input.addEventListener("change", function() {
			options.store(opt, opt.dataset.invert ? !input.checked : input.checked);
		});
	}
	else if(type === "offset-toggle") {
		input.addEventListener("change", function() {
			if(input.checked) {
				var seconds = options.$$(".opt[data-parent-offset]").filter(function(o) { return o.dataset.setting === "blinkMinTimeout"; })[0];
				options.store(opt, seconds ? seconds.dataset.default : "2000");
			} else {
				options.store(opt, "-1");
			}
		});
	}
	else {
		input.addEventListener("change", function() {
			var value = options.parseNumber(opt, input.value);
			if(value === null) {
				var range = (type === "seconds")
					? options.formatSeconds(opt.dataset.min) + " to " + options.formatSeconds(opt.dataset.max) + " seconds"
					: opt.dataset.min + " to " + opt.dataset.max;
				options.flash(opt, "Not valid, nothing saved. Allowed: " + range + ".", "error");
				return;
			}
			if(value === String(options.settings[opt.dataset.setting])) {
				options.renderOpt(opt);
				return;
			}
			options.store(opt, value);
		});
	}
};

options.initOptions = function() {
	options.$$(".opt[data-setting]").forEach(options.bindOpt);
	options.renderAll();

	if(!browser.webRequest || !browser.webRequest.onAuthRequired) {
		document.getElementById("http-auth-options").hidden = true;
	}
};

// ---------------------------------------------------------------- shortcuts

options.renderKeys = function(span, shortcut) {
	span.textContent = "";
	if(!shortcut) {
		var none = document.createElement("em");
		none.textContent = "not set";
		span.appendChild(none);
		return;
	}
	shortcut.split("+").forEach(function(part, i) {
		if(i > 0) {
			span.appendChild(document.createTextNode("+"));
		}
		var kbd = document.createElement("kbd");
		kbd.textContent = part;
		span.appendChild(kbd);
	});
};

options.initShortcuts = function() {
	if(browser.commands && browser.commands.getAll) {
		browser.commands.getAll().then(function(commands) {
			commands.forEach(function(c) {
				var span = options.$('.keys[data-command="' + c.name + '"]');
				if(span) {
					options.renderKeys(span, c.shortcut);
				}
			});
		}).catch(function() { /* keep the default keys from the HTML */ });
	}
	var button = document.getElementById("change-shortcuts");
	var help = document.getElementById("shortcut-help");
	if(browser.commands && typeof browser.commands.openShortcutSettings === "function") {
		button.hidden = false;
		help.hidden = true;
		button.addEventListener("click", function() {
			browser.commands.openShortcutSettings().catch(function() {
				button.hidden = true;
				help.hidden = false;
			});
		});
	}
};

// ---------------------------------------------------------------- tables

// Fill a table from a <template> (sites with chosen fields). Rows are replaced on every call. A "Remove"
// button asks in a <dialog> first; onRemove(key) deletes the stored data.
options.fillTable = function(tableId, templateId, dialogId, keys, fillRow, onRemove) {
	var tbody = options.$("#" + tableId + " tbody");
	var template = document.getElementById(templateId);
	var dialog = document.getElementById(dialogId);

	options.$$("tr:not(.empty)", tbody).forEach(function(tr) { tr.remove(); });

	var updateEmpty = function() {
		options.$("tr.empty", tbody).hidden = tbody.rows.length > 1;
	};

	keys.forEach(function(key, index) {
		var row = template.content.firstElementChild.cloneNode(true);
		var label = fillRow(row, key, index);
		options.$("button.delete", row).addEventListener("click", function() {
			options.$(".name", dialog).textContent = label;
			dialog.returnValue = "";
			var onClose = function() {
				dialog.removeEventListener("close", onClose);
				if(dialog.returnValue === "yes") {
					row.remove();
					onRemove(key);
					updateEmpty();
				}
			};
			dialog.addEventListener("close", onClose);
			dialog.showModal();
		});
		tbody.appendChild(row);
	});
	updateEmpty();
};

options.renderSpecifiedCredentialFields = function() {
	var fields = options.settings["defined-credential-fields"] || {};
	options.fillTable("fields-table", "row-specified-fields", "dialogDeleteSpecifiedCredentialFields",
		Object.keys(fields),
		function(row, url) {
			row.dataset.url = url;
			options.$(".url", row).textContent = url;
			return url;
		},
		function(url) {
			delete options.settings["defined-credential-fields"][url];
			options.saveSettings();
		});
};

options.initAbout = function() {
	options.$("#tab-about em.versionCIP").textContent = browser.runtime.getManifest().version;
};

// ---------------------------------------------------------------- start

browser.runtime.sendMessage({ action: 'load_settings' }).then(function(settings) {
	options.settings = settings || {};
	return browser.runtime.sendMessage({ action: 'load_keyring' });
}).then(function(keyRing) {
	options.keyRing = keyRing || {};
	options.initTabs();
	options.initInfoButtons();
	options.initOptions();
	options.initShortcuts();
	options.initCard();
	options.renderSpecifiedCredentialFields();
	options.initAbout();
	options.renderList();
	// Show the card at once with the last state the background knows (no
	// request to KeePass), then check for real. Right after the extension
	// started the background knows nothing yet: then the card waits for the
	// real check (no false "not answering"). Never with the unlock prompt on
	// page load: only "Unlock in KeePass" asks for it.
	return browser.runtime.sendMessage({ action: "check_connection", args: [false, true] }).then(function(s) {
		if(!options.conn && s && s.known) {
			options.applyStatus(s);
		}
	}, function() {}).then(function() {
		options.poll(true);
	});
});
