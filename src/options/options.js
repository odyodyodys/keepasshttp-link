// Settings page. Plain DOM, no library. Text from storage or KeePass is
// always inserted with textContent, never as HTML.

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

options.saveKeyRing = function() {
	return browser.storage.local.set({'keyRing': options.keyRing}).then(function() {
		return browser.runtime.sendMessage({ action: 'load_keyring' });
	});
};

options.initMenu = function() {
	var links = options.$$("nav a[role=tab]");
	var show = function(link) {
		links.forEach(function(a) {
			a.setAttribute("aria-selected", a === link ? "true" : "false");
		});
		options.$$("section.tab").forEach(function(tab) {
			tab.hidden = (tab.id !== "tab-" + link.getAttribute("href").substring(1));
		});
	};
	links.forEach(function(a) {
		a.addEventListener("click", function(e) {
			e.preventDefault();
			show(a);
		});
	});
	show(links[0]);
};

// Number fields with a Save button. check(value) returns the value to store
// as a string, or null when the input is not valid.
options.initNumberField = function(id, check) {
	var input = document.getElementById(id);
	var field = input.closest(".field");
	var status = options.$(".status", field);
	var timer = null;
	input.value = (options.settings[id] !== undefined) ? options.settings[id] : input.value;
	document.getElementById(id + "Button").addEventListener("click", function() {
		var value = check(input.value.trim());
		clearTimeout(timer);
		field.classList.remove("error", "success");
		if(value === null) {
			field.classList.add("error");
			status.textContent = "Not valid, nothing saved.";
			return;
		}
		options.settings[id] = value;
		options.saveSettings().then(function() {
			field.classList.add("success");
			status.textContent = "Saved.";
			timer = setTimeout(function() {
				field.classList.remove("success");
				status.textContent = "";
			}, 2500);
		});
	});
};

options.integer = function(min, max) {
	return function(text) {
		if(!/^-?[0-9]{1,9}$/.test(text)) {
			return null;
		}
		var n = parseInt(text, 10);
		return (n < min || n > max) ? null : String(n);
	};
};

options.initGeneralSettings = function() {
	options.$$("#tab-general-settings input[type=checkbox]").forEach(function(box) {
		box.checked = !!options.settings[box.name];
		box.addEventListener("change", function() {
			options.settings[box.name] = box.checked;
			options.saveSettings().then(function() {
				if(box.name === "autoFillAndSend") {
					browser.runtime.sendMessage({ action: "init_http_auth" });
				}
			});
		});
	});

	browser.runtime.sendMessage({ action: "get_keepasshttp_versions" }).then(options.showKeePassHttpVersions);

	options.initNumberField("blinkTimeout", options.integer(0, 600000));
	options.initNumberField("blinkMinTimeout", options.integer(-1, 600000));
	options.initNumberField("allowedRedirect", options.integer(0, 100));
	options.initNumberField("port", options.integer(1025, 65535));

	if(!browser.webRequest || !browser.webRequest.onAuthRequired) {
		document.getElementById("http-auth-options").hidden = true;
	}
};

options.showKeePassHttpVersions = function(response) {
	// The version is a string such as "2.3.1.0"; 0 or nothing means unknown.
	var v = response && response.current;
	var current = (!v || v <= 0) ? "unknown" : String(v);
	options.$("#tab-general-settings .kphVersion em.yourVersion").textContent = current;
	options.$("#tab-about em.versionKPH").textContent = current;
};

// A table filled from a <template>, with a "Remove" button that asks in a
// <dialog> first. onRemove(key) deletes the stored data.
options.initTable = function(tabId, templateId, dialogId, keys, fillRow, onRemove) {
	var tbody = options.$("#" + tabId + " table tbody");
	var template = document.getElementById(templateId);
	var dialog = document.getElementById(dialogId);
	var pending = null;

	var updateEmpty = function() {
		options.$("tr.empty", tbody).hidden = tbody.rows.length > 1;
	};

	dialog.addEventListener("close", function() {
		if(dialog.returnValue === "yes" && pending) {
			pending.row.remove();
			onRemove(pending.key);
			updateEmpty();
		}
		pending = null;
	});

	keys.forEach(function(key, index) {
		var row = template.content.firstElementChild.cloneNode(true);
		var label = fillRow(row, key, index);
		options.$("button.delete", row).addEventListener("click", function() {
			pending = { key: key, row: row };
			options.$(".name", dialog).textContent = label;
			dialog.returnValue = "";
			dialog.showModal();
		});
		tbody.appendChild(row);
	});
	updateEmpty();
};

options.initConnectedDatabases = function() {
	options.initTable("tab-connected-databases", "row-connected-database", "dialogDeleteConnectedDatabase",
		Object.keys(options.keyRing),
		function(row, hash) {
			var entry = options.keyRing[hash];
			row.id = "tr-cd-" + hash;
			options.$(".identifier", row).textContent = entry.id;
			options.$(".last-used", row).textContent = entry.lastUsed ? new Date(entry.lastUsed).toLocaleString() : "unknown";
			options.$(".created", row).textContent = entry.created ? new Date(entry.created).toLocaleDateString() : "unknown";
			options.colorPicker(options.$(".kph-color", row), hash);
			return String(entry.id);
		},
		function(hash) {
			delete options.keyRing[hash];
			options.saveKeyRing();
		});

	document.getElementById("connect-button").addEventListener("click", function() {
		browser.runtime.sendMessage({ action: "associate" });
	});
};

options.initSpecifiedCredentialFields = function() {
	var fields = options.settings["defined-credential-fields"] || {};
	options.initTable("tab-specified-fields", "row-specified-fields", "dialogDeleteSpecifiedCredentialFields",
		Object.keys(fields),
		function(row, url, index) {
			row.id = "tr-scf" + (index + 1);
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

// Toolbar icon color of one connected database: preset swatches, a custom
// "#rrggbb" field, and a preview on a light and a dark toolbar.
// The color is only used as a canvas or CSS color value.
options.colorPicker = function(container, hash) {
	var current = kphIcon.normalize(options.keyRing[hash].icon);

	var previews = document.createElement("div");
	previews.className = "kph-previews";
	var canvases = [false, true].map(function(dark) {
		var chip = document.createElement("span");
		chip.className = "kph-chip";
		chip.title = dark ? "Dark toolbar" : "Light toolbar";
		chip.style.background = dark ? "#2b2a33" : "#f9f9fb";
		var c = document.createElement("canvas");
		c.width = 32;
		c.height = 32;
		c.dataset.dark = dark ? "1" : "";
		chip.appendChild(c);
		previews.appendChild(chip);
		return c;
	});

	var input = document.createElement("input");
	input.type = "text";
	input.className = "kph-hex";
	input.maxLength = 7;
	input.placeholder = "#rrggbb";
	input.setAttribute("aria-label", "Custom color, #rrggbb");
	input.value = kphIcon.isHex(current) ? current : "";
	input.addEventListener("input", function() {
		var v = input.value.trim();
		var ok = kphIcon.isHex(v);
		input.classList.toggle("kph-invalid", v !== "" && !ok);
		if(ok) {
			set(v);
		}
	});

	var swatches = document.createElement("div");
	swatches.className = "kph-swatches";
	kphIcon.presets.forEach(function(p) {
		var b = document.createElement("button");
		b.type = "button";
		b.className = "kph-swatch";
		b.title = p.id;
		b.setAttribute("aria-label", p.id);
		b.dataset.color = p.id;
		b.style.background = p.light;
		b.addEventListener("click", function() {
			input.value = "";
			input.classList.remove("kph-invalid");
			set(p.id);
		});
		swatches.appendChild(b);
	});

	function draw() {
		canvases.forEach(function(c) {
			var ctx = c.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, 32, 32);
			ctx.scale(2, 2);
			kphIcon.paint(ctx, "normal", current, c.dataset.dark === "1");
		});
		Array.prototype.forEach.call(swatches.children, function(b) {
			b.classList.toggle("kph-selected", b.dataset.color === current);
		});
	}

	function set(value) {
		current = kphIcon.normalize(value);
		options.keyRing[hash].icon = current;
		options.saveKeyRing();
		draw();
	}

	container.appendChild(previews);
	container.appendChild(swatches);
	container.appendChild(input);
	draw();
};

browser.runtime.sendMessage({ action: 'load_settings' }).then(function(settings) {
	options.settings = settings;
	return browser.runtime.sendMessage({ action: 'load_keyring' });
}).then(function(keyRing) {
	options.keyRing = keyRing || {};
	options.initMenu();
	options.initGeneralSettings();
	options.initConnectedDatabases();
	options.initSpecifiedCredentialFields();
	options.initAbout();
});
