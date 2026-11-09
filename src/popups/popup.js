// Toolbar popup (status), on pages without logins to choose. It shows the
// same connection state as the settings page (A, A2, B, B-wait, B2, B3, C)
// with at most one action, and keeps itself current while it is open.
//
// Firefox closes the popup when another window takes the focus. So after
// "Give Firefox access" or "Unlock in KeePass" the popup usually closes
// while KeePass shows its window; the request goes on in the background.
// Opened again during a pairing, the popup shows "Waiting for KeePass".
//
// Names from the key ring and the site name are inserted as text only.

var kphPopup = {};

kphPopup.conn = null;      // last connection reply that was not "busy"
kphPopup.ring = {};        // key ring without keys
kphPopup.summary = null;   // { supported, site, logins } of the current tab
kphPopup.pairing = false;  // this popup waits for a pairing
kphPopup.busyAction = false;
kphPopup.checking = false;
kphPopup.POLL_MS = 2500;
kphPopup.timer = null;
kphPopup.PLUGIN_URL = "https://github.com/alan-null/keepasshttp/releases";

kphPopup.$ = function(id) {
	return document.getElementById(id);
};

kphPopup.send = function(action, args) {
	return browser.runtime.sendMessage({ action: action, args: args || [] });
};

// Same order as the settings page (SPEC section 3), plus "E" for an answer
// that failed the integrity check.
kphPopup.deriveState = function(s, ring, pairing) {
	if(!s || !s.pluginAvailable) {
		return "A";
	}
	if(s.databaseClosed) {
		return "A2";
	}
	if(s.pairingInFlight || pairing) {
		return "B-wait";
	}
	var entry = s.hash ? ring[s.hash] : null;
	if(entry && entry.status === "lost") {
		return "B3";
	}
	if(entry && s.associated) {
		return "C";
	}
	if(entry) {
		return s.integrityFailed ? "E" : "B3";
	}
	return Object.keys(ring).length === 0 ? "B" : "B2";
};

kphPopup.recentEntry = function(ring) {
	var best = null;
	Object.keys(ring).forEach(function(hash) {
		var e = ring[hash];
		var t = e.lastUsedAt || e.addedAt || 0;
		if(!best || t > best.t) {
			best = { t: t, entry: e };
		}
	});
	return best ? best.entry : null;
};

kphPopup.chip = function(name, kind) {
	var span = document.createElement("span");
	span.className = "chip " + kind;
	span.textContent = name;
	return span;
};

kphPopup.fill = function(el, parts) {
	el.textContent = "";
	parts.forEach(function(p) {
		el.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
	});
};

kphPopup.loginsText = function(n) {
	if(!n) {
		return "No logins";
	}
	return n === 1 ? "1 login" : n + " logins";
};

kphPopup.ICON = {
	"A": "x-circle", "A2": "lock", "B": "alert-circle", "B2": "alert-circle",
	"B-wait": "hourglass", "B3": "alert-circle", "C": "check-circle", "E": "alert-circle"
};

// Draws one view. view = { status, ring, summary, pairing }. Exposed for tests.
kphPopup.render = function(view) {
	var s = view.status;
	var ring = view.ring || {};
	var state = kphPopup.deriveState(s, ring, view.pairing);
	var firstRun = Object.keys(ring).length === 0;
	var entry = (s && s.hash) ? ring[s.hash] : null;
	var name = entry ? String(entry.id) : "";
	var port = String((s && s.port) || 19455);

	var body = kphPopup.$("p-body");
	body.hidden = false;
	body.dataset.state = state;

	var icon = kphPopup.$("p-state-icon");
	icon.className = "p-state-icon " + (state === "C" ? "ok" : "attention");
	kphUi.setIcon(icon, kphPopup.ICON[state], 20);

	var headline = kphPopup.$("p-headline");
	var sub = null;
	if(state === "A") {
		kphPopup.fill(headline, ["KeePass is not answering."]);
		sub = ["Firefox cannot reach the KeePassHttp plugin on port " + port + "."];
	} else if(state === "A2") {
		kphPopup.fill(headline, ["Your database is locked."]);
		sub = ["Unlock it in KeePass to fill passwords."];
	} else if(state === "B") {
		kphPopup.fill(headline, ["KeePass is running."]);
		sub = ["Firefox does not have access to the open database yet."];
	} else if(state === "B-wait") {
		kphPopup.fill(headline, ["Waiting for KeePass…"]);
		sub = ["Confirm in the KeePass window. It may be behind Firefox. Type a Key Name, for example Work."];
	} else if(state === "B2") {
		var recent = kphPopup.recentEntry(ring);
		kphPopup.fill(headline, ["Another database is open in KeePass."]);
		sub = recent
			? ["Give Firefox access to it, or switch KeePass back to ", kphPopup.chip(String(recent.id), "chip-text"), "."]
			: ["Give Firefox access to it."];
	} else if(state === "B3") {
		kphPopup.fill(headline, ["Firefox lost access to ", kphPopup.chip(name, "chip-headline"), "."]);
		sub = [(entry && entry.lostReason === "weak")
			? "Its key used an older, weaker format and was retired."
			: "KeePass no longer recognises the key Firefox stored for it."];
	} else if(state === "C") {
		kphPopup.fill(headline, ["Connected to ", kphPopup.chip(name, "chip-headline")]);
	} else if(state === "E") {
		kphPopup.fill(headline, ["KeePass answered, but the answer failed the security check."]);
		sub = ["Update the KeePassHttp plugin to 2.3 or newer."];
	}
	kphPopup.$("p-headline").parentNode.parentNode.classList.toggle("single", !sub);
	var subEl = kphPopup.$("p-sub");
	subEl.hidden = !sub;
	if(sub) {
		kphPopup.fill(subEl, sub);
	}

	// First run: "To get started" (A and B).
	var steps = kphPopup.$("p-steps");
	steps.hidden = !(firstRun && (state === "A" || state === "B"));
	if(!steps.hidden) {
		var ticked = (state === "B");
		Array.prototype.forEach.call(steps.querySelectorAll(".p-step"), function(row) {
			var n = row.dataset.row;
			var on = ticked && n !== "3";
			row.classList.toggle("done", on);
			var tick = row.querySelector(".p-tick");
			tick.classList.toggle("on", on);
			kphUi.setIcon(tick, on ? "check" : null, 10, 3);
			var text = row.querySelector(".p-step-text");
			if(n === "1") {
				if(on) {
					kphPopup.fill(text, ["Install the KeePassHttp plugin in KeePass."]);
				} else {
					var a = document.createElement("a");
					a.href = kphPopup.PLUGIN_URL;
					a.textContent = "Get the plugin";
					a.addEventListener("click", function(e) {
						e.preventDefault();
						browser.tabs.create({ url: kphPopup.PLUGIN_URL }).then(function() { window.close(); });
					});
					kphPopup.fill(text, ["Install the KeePassHttp plugin in KeePass. ", a]);
				}
			}
			if(n === "3") {
				text.textContent = (state === "B") ? "Give Firefox access to the database."
					: "Give Firefox access. The button appears here when KeePass answers.";
			}
		});
	}
	kphPopup.$("p-steps-action").hidden = !(state === "B" && !steps.hidden);
	kphPopup.$("p-steps-hint").hidden = !(state === "B" && !steps.hidden);

	// Connected: the current site (http and https pages only). With logins:
	// site, count and the field tools. Without: how to get a login for it.
	var summary = view.summary;
	var onSite = (state === "C" && summary && summary.supported);
	var site = kphPopup.$("p-site");
	site.hidden = !(onSite && summary.logins > 0);
	if(!site.hidden) {
		kphPopup.$("p-site-name").textContent = summary.site || "";
		kphPopup.$("p-site-count").textContent = kphPopup.loginsText(summary.logins);
	}
	var none = kphPopup.$("p-none");
	none.hidden = !(onSite && !(summary.logins > 0));
	if(!none.hidden) {
		var host = summary.site || "";
		// asked === false: no sign-in form found, KeePass was not asked yet.
		var noForm = (summary.asked === false);
		kphPopup.$("p-none-actions").hidden = !noForm;
		if(noForm) {
			kphPopup.fill(kphPopup.$("p-none-title"), ["No sign-in form found on " + host]);
			kphPopup.$("p-none-save").textContent = "If the page shows one, use Redetect fields. If the extension picks the wrong fields, use Choose fields.";
			kphPopup.$("p-none-url").textContent = "";
			kphPopup.$("p-none-url").hidden = true;
		} else {
			kphPopup.fill(kphPopup.$("p-none-title"), ["No logins for " + host + " in ", kphPopup.chip(name, "chip-text")]);
			kphPopup.$("p-none-save").textContent = "Sign in as usual. After you submit, the extension offers to save the login in KeePass.";
			kphPopup.$("p-none-url").textContent = "If the login already exists in KeePass, add " + host + " to the URL of that entry.";
			kphPopup.$("p-none-url").hidden = false;
		}
	}

	// The one action.
	var action = kphPopup.$("p-action");
	var label = null;
	if(state === "A2") { label = "Unlock in KeePass"; }
	else if(state === "B2") { label = "Give Firefox access"; }
	else if(state === "B3") { label = "Give access again"; }
	action.hidden = !label;
	if(label) {
		action.textContent = label;
		action.dataset.state = state;
		action.disabled = kphPopup.busyAction;
	}
	kphPopup.$("p-steps-action").disabled = kphPopup.busyAction;
	var cancel = kphPopup.$("p-cancel");
	cancel.hidden = (state !== "B-wait");
	if(cancel.hidden) {
		cancel.disabled = false;
	}

	kphPopup.state = state;
};

kphPopup.redraw = function() {
	if(!kphPopup.conn) {
		return; // nothing known yet: only the header
	}
	kphPopup.render({ status: kphPopup.conn, ring: kphPopup.ring, summary: kphPopup.summary, pairing: kphPopup.pairing });
};

kphPopup.apply = function(s) {
	if(s && s.busy && kphPopup.conn) {
		return; // KeePass did not answer in time: keep the last state
	}
	kphPopup.conn = s || { pluginAvailable: false };
	kphPopup.redraw();
};

// One check at a time, never with the unlock prompt (only the button asks).
kphPopup.poll = function() {
	clearTimeout(kphPopup.timer);
	if(kphPopup.checking || kphPopup.busyAction) {
		kphPopup.schedule();
		return;
	}
	kphPopup.checking = true;
	Promise.all([
		kphPopup.send("check_connection", [false]),
		kphPopup.send("load_keyring"),
		kphPopup.summaryRequest()
	]).then(function(r) {
		kphPopup.ring = r[1] || {};
		kphPopup.summary = r[2] || null;
		kphPopup.apply(r[0]);
		kphPopup.toChooserIfLogins();
	}, function() {
		kphPopup.apply(null);
	}).then(function() {
		kphPopup.checking = false;
		kphPopup.schedule();
	});
};

kphPopup.schedule = function() {
	clearTimeout(kphPopup.timer);
	kphPopup.timer = setTimeout(kphPopup.poll, kphPopup.POLL_MS);
};

kphPopup.pair = function(expectedHash) {
	kphPopup.pairing = true;
	kphPopup.busyAction = true;
	kphPopup.redraw();
	kphPopup.send("associate", expectedHash ? [expectedHash] : []).then(function() {}, function() {}).then(function() {
		kphPopup.pairing = false;
		kphPopup.busyAction = false;
		kphPopup.poll();
	});
};

// Sends an action to the page in the active tab. keepOpen: the popup stays
// (redetect: the next updates show what was found).
kphPopup.toActiveTab = function(action, keepOpen) {
	browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
		if(tabs.length) {
			return browser.tabs.sendMessage(tabs[0].id, { action: action });
		}
	}).then(function() {}, function() {}).then(function() {
		if(!keepOpen) {
			window.close();
		}
	});
};

// After "Redetect fields": when the page now has logins to choose from, show
// the login list in this popup (the next click on the icon opens it too).
kphPopup.redetecting = false;
kphPopup.toChooserIfLogins = function() {
	if(kphPopup.redetecting && kphPopup.summary && kphPopup.summary.choose > 0 && kphPopup.state === "C") {
		window.location.replace("popup_login.html");
	}
};

// The page summary of this popup's tab: the active tab of its own window,
// named by id (the background's current tab can be out of date, for example
// with several windows or in a private window).
kphPopup.tabId = null;
kphPopup.summaryRequest = function() {
	return kphPopup.send("get_page_summary", kphPopup.tabId ? [kphPopup.tabId] : []);
};

kphPopup.init = function() {
	var settings = kphPopup.$("p-settings");
	kphUi.setIcon(settings, "gear", 16);
	settings.addEventListener("click", function() {
		browser.runtime.openOptionsPage().then(function() { window.close(); });
	});

	kphPopup.$("p-action").addEventListener("click", function() {
		var state = this.dataset.state;
		if(state === "A2") {
			kphPopup.busyAction = true;
			kphPopup.redraw();
			kphPopup.send("check_connection", [true]).then(function(s) {
				kphPopup.busyAction = false;
				kphPopup.apply(s);
			}, function() {
				kphPopup.busyAction = false;
				kphPopup.redraw();
			});
		} else if(state === "B2") {
			kphPopup.pair(null);
		} else if(state === "B3") {
			kphPopup.pair(kphPopup.conn && kphPopup.conn.hash);
		}
	});
	kphPopup.$("p-steps-action").addEventListener("click", function() {
		kphPopup.pair(null);
	});
	kphPopup.$("p-cancel").addEventListener("click", function() {
		this.disabled = true;
		kphPopup.send("cancel_associate");
	});
	kphPopup.$("p-redetect").addEventListener("click", function() {
		kphPopup.redetecting = true;
		kphPopup.toActiveTab("redetect_fields", true);
		setTimeout(kphPopup.poll, 600);
	});
	kphPopup.$("p-choose").addEventListener("click", function() {
		kphPopup.toActiveTab("choose_credential_fields");
	});
	kphPopup.$("p-none-redetect").addEventListener("click", function() {
		kphPopup.redetecting = true;
		kphPopup.toActiveTab("redetect_fields", true);
		setTimeout(kphPopup.poll, 600);
	});
	kphPopup.$("p-none-choose").addEventListener("click", function() {
		kphPopup.toActiveTab("choose_credential_fields");
	});

	// First paint from the state the background already knows (no request),
	// then the real check. Unknown (just started): wait for the real check.
	browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
		kphPopup.tabId = tabs.length ? tabs[0].id : null;
	}, function() {}).then(function() {
		return Promise.all([
			kphPopup.send("check_connection", [false, true]),
			kphPopup.send("load_keyring"),
			kphPopup.summaryRequest()
		]);
	}).then(function(r) {
		kphPopup.ring = r[1] || {};
		kphPopup.summary = r[2] || null;
		if(r[0] && r[0].known) {
			kphPopup.apply(r[0]);
		}
	}, function() {}).then(kphPopup.poll);
};

kphPopup.init();
