// Toolbar popup "Choose a login": the logins KeePass returned for the page in
// the active tab. Only labels (login name and entry title) reach this popup;
// the chosen login is filled by the page's content script, in the frame that
// asked for the logins. Labels and site names are inserted as text only.

var kphChoose = {};

kphChoose.FILTER_FROM = 6;  // a filter field from this many logins on
kphChoose.items = [];       // { label, index } in KeePass order
kphChoose.shown = [];       // items after the filter
kphChoose.active = 0;       // index into shown
kphChoose.tabId = null;
kphChoose.frameId = 0;

kphChoose.$ = function(id) {
	return document.getElementById(id);
};

kphChoose.send = function(action, args) {
	return browser.runtime.sendMessage({ action: action, args: args || [] });
};

kphChoose.loginsText = function(n) {
	return n === 1 ? "1 login" : n + " logins";
};

kphChoose.render = function() {
	var list = kphChoose.$("login-list");
	list.textContent = "";
	kphChoose.shown.forEach(function(item, i) {
		var b = document.createElement("button");
		b.type = "button";
		b.className = "p-option";
		b.id = "login-" + item.index;
		b.setAttribute("role", "option");
		b.setAttribute("aria-selected", i === kphChoose.active ? "true" : "false");
		b.tabIndex = (i === kphChoose.active && kphChoose.$("p-filter").hidden) ? 0 : -1;
		var key = document.createElement("span");
		key.className = "p-key";
		key.appendChild(kphUi.keyIcon(16));
		var label = document.createElement("span");
		label.className = "p-label";
		label.textContent = item.label;
		var fill = document.createElement("span");
		fill.className = "p-fill";
		fill.textContent = "Fill";
		fill.setAttribute("aria-hidden", "true");
		b.appendChild(key);
		b.appendChild(label);
		b.appendChild(fill);
		b.addEventListener("click", function() {
			kphChoose.fill(item);
		});
		b.addEventListener("mousemove", function() {
			if(kphChoose.active !== i) {
				kphChoose.setActive(i, false);
			}
		});
		list.appendChild(b);
	});
	var input = kphChoose.$("p-filter-input");
	var activeItem = kphChoose.shown[kphChoose.active];
	if(activeItem) {
		input.setAttribute("aria-activedescendant", "login-" + activeItem.index);
	} else {
		input.removeAttribute("aria-activedescendant");
	}
};

kphChoose.setActive = function(i, focus) {
	if(kphChoose.shown.length === 0) {
		return;
	}
	kphChoose.active = Math.max(0, Math.min(i, kphChoose.shown.length - 1));
	var rows = kphChoose.$("login-list").querySelectorAll("[role=option]");
	var filtering = !kphChoose.$("p-filter").hidden;
	Array.prototype.forEach.call(rows, function(row, n) {
		var on = (n === kphChoose.active);
		row.setAttribute("aria-selected", on ? "true" : "false");
		row.tabIndex = (on && !filtering) ? 0 : -1;
		if(on) {
			row.scrollIntoView({ block: "nearest" });
			if(focus && !filtering) {
				row.focus();
			}
		}
	});
	var item = kphChoose.shown[kphChoose.active];
	kphChoose.$("p-filter-input").setAttribute("aria-activedescendant", "login-" + item.index);
};

kphChoose.applyFilter = function() {
	var term = kphChoose.$("p-filter-input").value.trim().toLowerCase();
	kphChoose.shown = kphChoose.items.filter(function(item) {
		return term === "" || item.label.toLowerCase().indexOf(term) >= 0;
	});
	kphChoose.active = 0;
	kphChoose.render();
};

// Only the frame that asked for the logins fills them.
kphChoose.fill = function(item) {
	if(!item || kphChoose.tabId === null) {
		return;
	}
	browser.tabs.sendMessage(kphChoose.tabId, {
		action: "fill_user_pass_with_specific_login",
		id: String(item.index)
	}, { frameId: kphChoose.frameId }).then(function() {}, function() {}).then(function() {
		window.close();
	});
};

kphChoose.onKey = function(e) {
	if(e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		kphChoose.setActive(kphChoose.active + (e.key === "ArrowDown" ? 1 : -1), true);
	}
	else if(e.key === "Enter") {
		// A focused row handles Enter as its own click.
		if(document.activeElement && document.activeElement.getAttribute("role") === "option") {
			return;
		}
		if(document.activeElement && document.activeElement.id === "p-settings") {
			return;
		}
		e.preventDefault();
		kphChoose.fill(kphChoose.shown[kphChoose.active]);
	}
	else if(e.key === "Escape") {
		e.preventDefault();
		window.close();
	}
};

kphChoose.init = function() {
	var settings = kphChoose.$("p-settings");
	kphUi.setIcon(settings, "gear", 16);
	settings.addEventListener("click", function() {
		browser.runtime.openOptionsPage().then(function() { window.close(); });
	});
	kphUi.setIcon(kphChoose.$("p-filter-icon"), "search", 14);
	kphChoose.$("p-filter-input").addEventListener("input", kphChoose.applyFilter);
	document.addEventListener("keydown", kphChoose.onKey);

	// The connected database (state the background already knows).
	Promise.all([kphChoose.send("check_connection", [false, true]), kphChoose.send("load_keyring")]).then(function(r) {
		var s = r[0];
		var entry = (s && s.hash && r[1]) ? r[1][s.hash] : null;
		if(s && s.associated && entry) {
			var chip = document.createElement("span");
			chip.className = "chip chip-headline";
			chip.textContent = String(entry.id);
			var h = kphChoose.$("p-headline");
			h.textContent = "Connected to ";
			h.appendChild(chip);
			kphUi.setIcon(kphChoose.$("p-state-icon"), "check-circle", 20);
			kphChoose.$("p-connected").hidden = false;
		}
	}, function() {});

	// The list of the active tab of this popup's window, asked by tab id. Not
	// with runtime.getBackgroundPage(): it returns null in a private window.
	var activeTab = null;
	browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
		if(tabs.length === 0) {
			return null; // for example only the devtools or a popup are open
		}
		activeTab = tabs[0];
		return kphChoose.send("get_login_list", [activeTab.id]);
	}).then(function(info) {
		if(!activeTab) {
			return;
		}
		var tab = activeTab;
		info = info || {};
		var labels = (info.kind === "logins" && Array.isArray(info.labels)) ? info.labels : [];
		kphChoose.tabId = tab.id;
		kphChoose.frameId = (typeof info.frameId === "number") ? info.frameId : 0;
		kphChoose.items = labels.map(function(label, i) {
			return { label: String(label), index: i };
		});
		// The site of the active tab (the page the logins are for).
		var site = null;
		try {
			var u = new URL(tab.url);
			if(u.protocol === "https:" || u.protocol === "http:") {
				site = u.hostname;
			}
		} catch(e) { /* no URL: "this page" */ }
		site = site || "this page";
		kphChoose.$("p-choose-title").textContent = "Fill the sign-in fields on " + site + " with";
		kphChoose.$("p-choose-count").textContent = kphChoose.loginsText(kphChoose.items.length);
		kphChoose.$("login-list").setAttribute("aria-label", "Logins for " + site);
		kphChoose.$("p-filter").hidden = kphChoose.items.length < kphChoose.FILTER_FROM;
		kphChoose.shown = kphChoose.items.slice();
		kphChoose.active = 0;
		kphChoose.render();
		if(!kphChoose.$("p-filter").hidden) {
			kphChoose.$("p-filter-input").focus();
		} else {
			var first = kphChoose.$("login-list").querySelector("[role=option]");
			if(first) {
				first.focus();
			}
		}
	});
};

kphChoose.init();
