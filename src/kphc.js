
// Item 17d: no jQuery in web pages. Small DOM helpers below.

// Sandboxed frame or document (opaque origin "null"): do nothing at all.
// The background cannot see the sandbox flag, so this check is here.
var kphcSandboxed = (window.origin === "null");

// True only for an event made by the user (not by a page script).
function kphcIsTrusted(e) {
	return !!(e && e.isTrusted === true);
}

// Per-element data of this extension (not visible to the page).
var kphcDataStore = new WeakMap();
function kphcData(el, key, value) {
	if (!el) {
		return undefined;
	}
	var m = kphcDataStore.get(el);
	if (arguments.length > 2) {
		if (!m) {
			m = {};
			kphcDataStore.set(el, m);
		}
		m[key] = value;
		return value;
	}
	return m ? m[key] : undefined;
}
function kphcRemoveData(el, key) {
	var m = el && kphcDataStore.get(el);
	if (m) {
		delete m[key];
	}
}

// Visible = has a layout box and is not visibility:hidden/collapse.
function kphcVisible(el) {
	if (!el || !el.isConnected) {
		return false;
	}
	if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) {
		return false;
	}
	var v = getComputedStyle(el).visibility;
	return v !== "hidden" && v !== "collapse";
}

// Field ids are kept CSS-escaped (cipFields.prepareId), also in saved settings.
// Lookup compares attribute values; no selector is built from page values.
function kphcUnescapeId(id) {
	return String(id).replace(/\\([:#.,\[\]\(\)' "])/g, "$1");
}
function kphcFindByCipId(selector, fieldId) {
	if (fieldId === null || fieldId === undefined || fieldId === "") {
		return null;
	}
	var raw = kphcUnescapeId(fieldId);
	var list = document.querySelectorAll(selector);
	for (var i = 0; i < list.length; i++) {
		if (list[i].getAttribute("data-cip-id") === raw) {
			return list[i];
		}
	}
	return null;
}

// Last value of each username field typed by the user (trusted input events).
var kphcTypedValues = new WeakMap();

// contains already called method names
var _called = {};

// Count of detected form fields on the page
var _detectedFields = 0;

browser.runtime.onMessage.addListener(function(req, sender, callback) {
	if (kphcSandboxed) {
		return;
	}
	if ('action' in req) {
		if(req.action == "fill_user_pass_with_specific_login") {
			if(cip.credentials[req.id]) {
				var combination = null;
				if (cip.u) {
					combination = cipFields.getCombination("username", cipFields.idOf(cip.u));
				}
				if (cip.p) {
					combination = cipFields.getCombination("password", cipFields.idOf(cip.p));
				}
				var u = cip.u;
				cip.fillEntry(req.id, cip.u, cip.p, combination ? combination.fields : null, {}).then(function() {
					if (u) {
						u.focus();
					}
				});
			}
			// wish I could clear out _logins and _u, but a subsequent
			// selection may be requested.
		}
		else if (req.action == "fill_user_pass") {
			cip.receiveCredentialsIfNecessary();
			cip.fillInFromActiveElement(false);
		}
		else if (req.action == "fill_pass_only") {
			cip.receiveCredentialsIfNecessary();
			cip.fillInFromActiveElementPassOnly(false);
		}
		else if (req.action == "activate_password_generator") {
			cip.initPasswordGenerator(cipFields.getAllFields());
		}
		else if(req.action == "remember_credentials") {
			cip.contextMenuRememberCredentials();
		}
		else if (req.action == "choose_credential_fields") {
			cipDefine.init();
		}
		else if (req.action == "clear_credentials") {
			cipEvents.clearCredentials();
			// KeePass was locked: fetch again on the next real focus of a username field.
			if (req.reason === "locked") {
				cip.refetchOnFocus = true;
			}
		}
		else if (req.action == "activated_tab") {
			cipEvents.triggerActivatedTab();
		}
		else if (req.action == "redetect_fields") {
			browser.runtime.sendMessage({
				"action": "load_settings",
			}).then(function(settings) {
				cip.settings = settings;
				cip.initCredentialFields(true);
			});
		}
	}
});

// Field (input) for a combination id, or null.
function _f(fieldId) {
	return kphcFindByCipId("input[data-cip-id]", fieldId);
}

// Field (input or select) for a string-field id, or null.
function _fs(fieldId) {
	return kphcFindByCipId("input[data-cip-id], select[data-cip-id]", fieldId);
}



// Item 18: one MutationObserver instead of polling timers. It watches the page
// while it is needed: to find login fields that appear later, and to keep the
// key icons next to their fields. Changes to our own <kphc-*> elements are
// ignored (no loop). At most one check per 250 ms.
var kphcObserver = {
	mo: null,
	ro: null,
	timer: null,
	frame: null,
	wantDetect: false
};

kphcObserver.isOwn = function(node) {
	return !!(node && node.nodeType === 1 && node.tagName.indexOf("KPHC-") === 0);
}

kphcObserver.relevant = function(records) {
	for (var i = 0; i < records.length; i++) {
		var r = records[i];
		if (r.type === "attributes") {
			if (!kphcObserver.isOwn(r.target)) {
				return true;
			}
			continue;
		}
		var nodes = Array.prototype.slice.call(r.addedNodes).concat(Array.prototype.slice.call(r.removedNodes));
		for (var j = 0; j < nodes.length; j++) {
			if (!kphcObserver.isOwn(nodes[j])) {
				return true;
			}
		}
	}
	return false;
}

kphcObserver.needed = function() {
	return kphcObserver.wantDetect || cipPassword.observedIcons.length > 0;
}

// Connect or disconnect, as needed.
kphcObserver.update = function() {
	if (kphcObserver.needed() && !kphcObserver.mo) {
		kphcObserver.mo = new MutationObserver(function(records) {
			if (kphcObserver.relevant(records)) {
				kphcObserver.schedule();
			}
		});
		kphcObserver.mo.observe(document.documentElement, { childList: true, subtree: true,
			attributes: true, attributeFilter: ["style", "class", "hidden", "type", "disabled"] });
		window.addEventListener("scroll", kphcObserver.onViewport, true);
		window.addEventListener("resize", kphcObserver.onViewport);
		document.addEventListener("visibilitychange", kphcObserver.schedule);
		kphcObserver.schedule();
	}
	else if (!kphcObserver.needed() && kphcObserver.mo) {
		kphcObserver.mo.disconnect();
		kphcObserver.mo = null;
		window.removeEventListener("scroll", kphcObserver.onViewport, true);
		window.removeEventListener("resize", kphcObserver.onViewport);
		document.removeEventListener("visibilitychange", kphcObserver.schedule);
	}
}

kphcObserver.schedule = function() {
	if (kphcObserver.timer === null) {
		kphcObserver.timer = setTimeout(kphcObserver.run, 250);
	}
}

// Scroll / resize: move the icons on the next frame (no 250 ms delay).
kphcObserver.onViewport = function() {
	if (kphcObserver.frame === null) {
		kphcObserver.frame = requestAnimationFrame(function() {
			kphcObserver.frame = null;
			cipPassword.checkObservedElements();
		});
	}
}

// A field with an icon changed size without a DOM change (e.g. CSS layout).
kphcObserver.watchSize = function(field) {
	if (typeof ResizeObserver === "undefined") {
		return;
	}
	if (!kphcObserver.ro) {
		kphcObserver.ro = new ResizeObserver(kphcObserver.onViewport);
	}
	kphcObserver.ro.observe(field);
}

kphcObserver.run = function() {
	kphcObserver.timer = null;
	if (kphcObserver.wantDetect && document.visibilityState !== "hidden") {
		cip.checkNewFields();
	}
	cipPassword.checkObservedElements();
	kphcObserver.update();
}


// Login dropdown (item 17a). Own code, no jQuery UI. It lives in a CLOSED
// shadow root: page scripts cannot read the login names, restyle the list or
// click an item (and a script click is not trusted anyway, see select).
// Styles are set with the CSSOM (el.style), which a page CSP does not block.
var cipAutocomplete = {};

// {label, value, loginId} for the current page
cipAutocomplete.elements = [];
// native field -> {enabled, handlers}
cipAutocomplete.state = new WeakMap();
cipAutocomplete.host = null;
cipAutocomplete.list = null;
cipAutocomplete.openFor = null;
cipAutocomplete.shown = [];
cipAutocomplete.active = -1;

function kphcStyle(el, props) {
	for (var name in props) {
		el.style.setProperty(name, props[name], "important");
	}
	return el;
}

cipAutocomplete.ensureHost = function() {
	if (cipAutocomplete.host && cipAutocomplete.host.isConnected) {
		return;
	}
	var host = document.createElement("kphc-dropdown");
	host.id = "kphc-ac-host";
	kphcStyle(host, { "all": "initial", "position": "absolute", "display": "none",
		"z-index": "2147483647", "left": "0px", "top": "0px" });
	var root = host.attachShadow({ mode: "closed" });
	var list = document.createElement("ul");
	list.setAttribute("role", "listbox");
	root.appendChild(list);
	// Keep the focus in the field when the user clicks the list.
	list.addEventListener("mousedown", function(e) { e.preventDefault(); });
	list.addEventListener("click", function(e) {
		var li = e.target.closest ? e.target.closest("li[data-index]") : null;
		if (li) {
			cipAutocomplete.select(e, Number(li.getAttribute("data-index")));
		}
	});
	list.addEventListener("mousemove", function(e) {
		var li = e.target.closest ? e.target.closest("li[data-index]") : null;
		if (li) {
			cipAutocomplete.setActive(Number(li.getAttribute("data-index")));
		}
	});
	document.documentElement.appendChild(host);
	cipAutocomplete.host = host;
	cipAutocomplete.list = list;
}

cipAutocomplete.init = function(field) {
	var el = field;
	if (!el) {
		return;
	}
	var st = cipAutocomplete.state.get(el);
	if (st) {
		// Second init (re-detect): same handlers, only enable again.
		st.enabled = true;
		return;
	}
	st = { enabled: true, handlers: {
		input: cipAutocomplete.onInput,
		click: cipAutocomplete.onClick,
		blur: cipAutocomplete.onBlur,
		focus: cipAutocomplete.onFocus,
		keydown: cipAutocomplete.onKeyDown
	} };
	cipAutocomplete.state.set(el, st);
	for (var type in st.handlers) {
		el.addEventListener(type, st.handlers[type]);
	}
}

// Logins cleared: no dropdown, but the handlers stay (focus after a KeePass
// lock fetches the logins again, see onFocus).
cipAutocomplete.disable = function(field) {
	var el = field;
	var st = el && cipAutocomplete.state.get(el);
	if (st) {
		st.enabled = false;
	}
	if (cipAutocomplete.openFor === el) {
		cipAutocomplete.close();
	}
}

cipAutocomplete.isEnabled = function(el) {
	var st = el && cipAutocomplete.state.get(el);
	return !!(st && st.enabled);
}

cipAutocomplete.open = function(el, term) {
	if (!cipAutocomplete.isEnabled(el)) {
		return;
	}
	term = String(term || "").toUpperCase();
	var matches = cipAutocomplete.elements.filter(function(item) {
		return item.label.toUpperCase().indexOf(term) === 0;
	});
	if (matches.length === 0) {
		cipAutocomplete.close();
		return;
	}
	cipAutocomplete.ensureHost();
	var list = cipAutocomplete.list;
	var insecure = cip.isInsecurePage();
	while (list.firstChild) {
		list.removeChild(list.firstChild);
	}
	kphcStyle(list, { "margin": "0", "padding": "2px 0", "list-style": "none", "min-width": insecure ? "300px" : "160px",
		"background": insecure ? "#fff0f0" : "#ffffff", "border": insecure ? "2px solid #b00020" : "1px solid #aaaaaa",
		"box-shadow": "0 2px 6px rgba(0,0,0,0.25)", "font": "12px Verdana, Arial, sans-serif", "color": "#222222",
		"text-align": "left", "max-height": "300px", "overflow-y": "auto" });
	// Not-secure page: red list with a warning line on top. The line has no
	// data-index, so it cannot be selected (mouse or keyboard).
	if (insecure) {
		var warn = document.createElement("li");
		warn.setAttribute("role", "alert");
		warn.className = "kphc-insecure-warning";
		warn.textContent = cip.insecureWarningText;
		kphcStyle(warn, { "padding": "4px 6px", "background": "#b00020", "color": "#ffffff",
			"font-weight": "bold", "cursor": "default", "white-space": "normal" });
		list.appendChild(warn);
	}
	cipAutocomplete.shown = matches;
	for (var i = 0; i < matches.length; i++) {
		var li = document.createElement("li");
		li.setAttribute("role", "option");
		li.setAttribute("data-index", String(i));
		li.textContent = matches[i].label;
		kphcStyle(li, { "padding": "3px 6px", "cursor": "pointer", "white-space": "nowrap" });
		list.appendChild(li);
	}
	cipAutocomplete.openFor = el;
	cipAutocomplete.setActive(-1);
	cipAutocomplete.position();
	kphcStyle(cipAutocomplete.host, { "display": "block" });
}

cipAutocomplete.position = function() {
	var el = cipAutocomplete.openFor;
	if (!el || !cipAutocomplete.host) {
		return;
	}
	var r = el.getBoundingClientRect();
	kphcStyle(cipAutocomplete.host, {
		"left": Math.round(r.left + window.scrollX) + "px",
		"top": Math.round(r.bottom + window.scrollY) + "px",
		"min-width": Math.round(r.width) + "px"
	});
}

cipAutocomplete.close = function() {
	cipAutocomplete.openFor = null;
	cipAutocomplete.shown = [];
	cipAutocomplete.active = -1;
	if (cipAutocomplete.host) {
		kphcStyle(cipAutocomplete.host, { "display": "none" });
	}
}

cipAutocomplete.setActive = function(index) {
	cipAutocomplete.active = index;
	var items = cipAutocomplete.list ? cipAutocomplete.list.querySelectorAll("li[data-index]") : [];
	for (var i = 0; i < items.length; i++) {
		var on = (i === index);
		kphcStyle(items[i], { "background": on ? "#2a6fd6" : "transparent", "color": on ? "#ffffff" : "#222222" });
		if (on && items[i].scrollIntoView) {
			items[i].scrollIntoView({ block: "nearest" });
		}
	}
}

// Fill the chosen login. Only for a real user action (trusted click or key).
cipAutocomplete.select = function(e, index) {
	if (!kphcIsTrusted(e)) {
		return;
	}
	var el = cipAutocomplete.openFor;
	var item = cipAutocomplete.shown[index];
	if (!el || !item) {
		return;
	}
	cipAutocomplete.close();
	cip.setValueWithChange(el, item.value);
	var combination = cipFields.getCombination("username", cipFields.idOf(el));
	combination.loginId = item.loginId;
	cip.fillInCredentials(combination, true, false);
	kphcData(el, "fetched", true);
}

cipAutocomplete.onKeyDown = function(e) {
	// Key events made by a page script never move or choose anything.
	if (!kphcIsTrusted(e)) {
		return;
	}
	var isOpen = cipAutocomplete.openFor === this;
	switch (e.key) {
		case "ArrowDown":
			e.preventDefault();
			if (!isOpen) {
				cipAutocomplete.open(this, this.value);
				return;
			}
			cipAutocomplete.setActive(Math.min(cipAutocomplete.active + 1, cipAutocomplete.shown.length - 1));
			break;
		case "ArrowUp":
			if (isOpen) {
				e.preventDefault();
				cipAutocomplete.setActive(Math.max(cipAutocomplete.active - 1, 0));
			}
			break;
		case "Enter":
			if (isOpen && cipAutocomplete.active >= 0) {
				e.preventDefault();
				cipAutocomplete.select(e, cipAutocomplete.active);
			}
			break;
		case "Escape":
			if (isOpen) {
				e.preventDefault();
				cipAutocomplete.close();
			}
			break;
		case "Tab":
			cipAutocomplete.close();
			break;
	}
}

cipAutocomplete.onInput = function(e) {
	if(kphcIsTrusted(e)) {
		kphcTypedValues.set(this, this.value);
		cipAutocomplete.open(this, this.value);
	}
	else {
		kphcTypedValues.delete(this);
	}
}

cipAutocomplete.onClick = function(e) {
	if(!kphcIsTrusted(e)) {
		return;
	}
	cipAutocomplete.open(this, this.value);
}

cipAutocomplete.onBlur = function(e) {
	if (cipAutocomplete.openFor === this) {
		cipAutocomplete.close();
	}
	if(kphcData(this, "fetched") == true) {
		kphcData(this, "fetched", false);
	}
	// Fill the password for a typed username only if the user typed it and
	// the user left the field. A script can call blur() (trusted event) but
	// cannot type, so both checks are needed.
	else if(kphcIsTrusted(e) && kphcTypedValues.get(this) === this.value) {
		var fields = cipFields.getCombination("username", cipFields.idOf(this));
		if(_f(fields.password) && kphcData(_f(fields.password), "unchanged") != true && this.value != "") {
			cip.fillInCredentials(fields, true, true);
		}
	}
}

cipAutocomplete.onFocus = function(e) {
	cip.u = this;
	var el = this;

	// Still locked: no answer, the flag stays and the next focus tries again.
	if(cip.refetchOnFocus && kphcIsTrusted(e)) {
		cip.retrieveCredentials(true).then(function() {
			if(cip.credentials.length > 0) {
				cip.refetchOnFocus = false;
			}
			if(document.activeElement === el && el.value == "") {
				cipAutocomplete.open(el, "");
			}
		});
		return;
	}

	if(el.value == "") {
		cipAutocomplete.open(el, "");
	}
}

// Keep the list under its field when the page scrolls or resizes.
window.addEventListener("scroll", function() { cipAutocomplete.position(); }, true);
window.addEventListener("resize", function() { cipAutocomplete.position(); });



// Password generator (item 17b). Own code, no jQuery UI dialog. The key icons
// and the dialog live in CLOSED shadow roots: page scripts cannot read the
// generated password from the dialog, restyle it or press its buttons.
// Styles via CSSOM (kphcStyle), so a page CSP does not block them.
var cipPassword = {};

// {host, inner, field (jQuery), size, offset}
cipPassword.observedIcons = [];
cipPassword.observingLock = false;
cipPassword.dialog = null;

cipPassword.init = function() {
	if("initPasswordGenerator" in _called) {
		return;
	}
	_called.initPasswordGenerator = true;
	// Icon positions are kept up to date by kphcObserver (no polling).
}

cipPassword.initField = function(field, inputs, pos) {
	if(!field) {
		return;
	}
	if(kphcData(field, "cip-password-generator")) {
		return;
	}

	kphcData(field, "cip-password-generator", true);

	cipPassword.createIcon(field);

	// The next password field (e.g. "repeat password"), for "also fill in".
	var next = null;
	if(inputs) {
		for(var i = pos + 1; i < inputs.length; i++) {
			if(inputs[i] && cipFields.isPasswordInput(inputs[i])) {
				next = inputs[i];
				break;
			}
		}
	}
	kphcData(field, "cip-genpw-next-field", next);
}

// A small key drawn with SVG (no image file, no extension URL in the page).
cipPassword.keyIcon = function(size) {
	var NS = "http://www.w3.org/2000/svg";
	var svg = document.createElementNS(NS, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	var head = document.createElementNS(NS, "circle");
	head.setAttribute("cx", "7.5");
	head.setAttribute("cy", "12");
	head.setAttribute("r", "4.5");
	head.setAttribute("fill", "none");
	head.setAttribute("stroke", "#1f5fbf");
	head.setAttribute("stroke-width", "2.5");
	var shaft = document.createElementNS(NS, "path");
	shaft.setAttribute("d", "M12 12h10M18 12v4M21 12v3");
	shaft.setAttribute("fill", "none");
	shaft.setAttribute("stroke", "#1f5fbf");
	shaft.setAttribute("stroke-width", "2.5");
	shaft.setAttribute("stroke-linecap", "round");
	svg.appendChild(head);
	svg.appendChild(shaft);
	return svg;
}

cipPassword.createIcon = function(field) {
	var height = field.offsetHeight;
	var size = (height > 28) ? 24 : 16;
	var offset = Math.floor((height - size) / 3);
	offset = (offset < 0) ? 0 : offset;

	var zIndex = 0;
	var zField = field;
	var c = 0;
	while(zField && zField.nodeType === 1 && c <= 100) {
		var z = parseInt(getComputedStyle(zField).zIndex, 10);
		if(!isNaN(z) && z > zIndex) {
			zIndex = z;
		}
		zField = zField.parentElement;
		c++;
	}
	if(isNaN(zIndex) || zIndex < 1) {
		zIndex = 1;
	}
	zIndex += 1;

	var host = document.createElement("kphc-key");
	kphcStyle(host, { "all": "initial", "position": "absolute", "display": "block",
		"width": size + "px", "height": size + "px", "z-index": String(zIndex), "cursor": "pointer" });
	var root = host.attachShadow({ mode: "closed" });
	var inner = document.createElement("div");
	inner.setAttribute("role", "button");
	inner.setAttribute("title", "Generate a password (KeePass)");
	kphcStyle(inner, { "width": size + "px", "height": size + "px", "cursor": "pointer" });
	inner.appendChild(cipPassword.keyIcon(size));
	root.appendChild(inner);

	var icon = { host: host, inner: inner, field: field, size: size, offset: offset };
	inner.addEventListener("click", function(e) {
		e.preventDefault();
		if(!kphcIsTrusted(e)) {
			return;
		}
		if(!kphcVisible(field)) {
			cipPassword.removeIcon(icon);
			kphcRemoveData(field, "cip-password-generator");
			return;
		}
		cipPassword.openDialog(field, host);
	});

	cipPassword.observedIcons.push(icon);
	document.documentElement.appendChild(host);
	cipPassword.setIconPosition(icon);
	kphcObserver.watchSize(field);
	kphcObserver.update();
}

cipPassword.removeIcon = function(icon) {
	if(icon.host.parentNode) {
		icon.host.parentNode.removeChild(icon.host);
	}
	var i = cipPassword.observedIcons.indexOf(icon);
	if(i >= 0) {
		cipPassword.observedIcons.splice(i, 1);
	}
	if(kphcObserver.ro && icon.field) {
		kphcObserver.ro.unobserve(icon.field);
	}
}

cipPassword.setIconPosition = function(icon) {
	var r = icon.field.getBoundingClientRect();
	kphcStyle(icon.host, {
		"top": Math.round(r.top + window.scrollY + icon.offset + 1) + "px",
		"left": Math.round(r.left + window.scrollX + r.width - icon.size - icon.offset) + "px"
	});
}

cipPassword.button = function(text, primary) {
	var b = document.createElement("button");
	b.type = "button";
	b.textContent = text;
	kphcStyle(b, { "font": "12px Verdana, Arial, sans-serif", "padding": "3px 8px", "margin": "0 4px 4px 0",
		"border": "1px solid " + (primary ? "#1f5fbf" : "#999999"), "border-radius": "3px", "cursor": "pointer",
		"background": primary ? "#2a6fd6" : "#f2f2f2", "color": primary ? "#ffffff" : "#222222" });
	return b;
}

cipPassword.ensureDialog = function() {
	if(cipPassword.dialog && cipPassword.dialog.host.isConnected) {
		return cipPassword.dialog;
	}
	var d = {};
	d.host = document.createElement("kphc-pwgen");
	kphcStyle(d.host, { "all": "initial", "display": "none" });
	var root = d.host.attachShadow({ mode: "closed" });

	d.overlay = document.createElement("div");
	kphcStyle(d.overlay, { "position": "fixed", "left": "0", "top": "0", "right": "0", "bottom": "0",
		"background": "rgba(0,0,0,0.15)", "z-index": "2147483646" });
	d.box = document.createElement("div");
	d.box.setAttribute("role", "dialog");
	d.box.setAttribute("aria-label", "Password Generator");
	kphcStyle(d.box, { "position": "fixed", "z-index": "2147483647", "width": "340px", "box-sizing": "border-box",
		"background": "#ffffff", "border": "1px solid #888888", "border-radius": "4px", "padding": "8px 10px",
		"box-shadow": "0 4px 12px rgba(0,0,0,0.3)", "font": "12px Verdana, Arial, sans-serif", "color": "#222222",
		"text-align": "left" });

	var title = document.createElement("div");
	kphcStyle(title, { "font-weight": "bold", "margin-bottom": "8px", "display": "flex", "justify-content": "space-between" });
	var titleText = document.createElement("span");
	titleText.textContent = "Password Generator";
	d.btnClose = document.createElement("span");
	d.btnClose.setAttribute("role", "button");
	d.btnClose.setAttribute("aria-label", "Close");
	d.btnClose.textContent = "×";
	kphcStyle(d.btnClose, { "cursor": "pointer", "font-size": "16px", "line-height": "12px" });
	title.appendChild(titleText);
	title.appendChild(d.btnClose);

	d.btnGenerate = cipPassword.button("Generate", true);
	d.btnClipboard = cipPassword.button("Copy to clipboard", false);
	d.input = document.createElement("input");
	d.input.type = "text";
	d.input.setAttribute("aria-label", "Generated password");
	kphcStyle(d.input, { "width": "240px", "font": "12px monospace", "padding": "2px 4px", "border": "1px solid #aaaaaa",
		"margin": "6px 4px 6px 0", "color": "#222222", "background": "#ffffff" });
	d.quality = document.createElement("span");
	d.quality.textContent = "";
	d.label = document.createElement("label");
	kphcStyle(d.label, { "display": "block", "margin": "4px 0 8px 0" });
	d.checkbox = document.createElement("input");
	d.checkbox.type = "checkbox";
	d.label.appendChild(d.checkbox);
	d.label.appendChild(document.createTextNode(" also fill in the next password-field"));
	d.btnFillIn = cipPassword.button("Fill in & copy to clipboard", false);
	d.message = document.createElement("div");
	d.message.setAttribute("role", "status");
	kphcStyle(d.message, { "color": "#b00020", "margin-top": "4px", "white-space": "pre-line" });

	var row = document.createElement("div");
	row.appendChild(d.btnGenerate);
	row.appendChild(d.btnClipboard);
	var pwRow = document.createElement("div");
	pwRow.appendChild(d.input);
	pwRow.appendChild(d.quality);
	d.box.appendChild(title);
	d.box.appendChild(row);
	d.box.appendChild(pwRow);
	d.box.appendChild(d.label);
	d.box.appendChild(d.btnFillIn);
	d.box.appendChild(d.message);
	root.appendChild(d.overlay);
	root.appendChild(d.box);

	// Only real user clicks act (a page script cannot reach these elements,
	// and its events are not trusted).
	var onTrusted = function(el, fn) {
		el.addEventListener("click", function(e) {
			e.preventDefault();
			if(kphcIsTrusted(e)) {
				fn();
			}
		});
	};
	onTrusted(d.overlay, cipPassword.closeDialog);
	onTrusted(d.btnClose, cipPassword.closeDialog);
	onTrusted(d.btnGenerate, cipPassword.generate);
	onTrusted(d.btnClipboard, function() { cipPassword.copyPasswordToClipboard(); });
	onTrusted(d.btnFillIn, cipPassword.fillIn);
	d.input.addEventListener("input", function() {
		d.message.textContent = "";
		kphcStyle(d.message, { "color": "#b00020" });
	});
	d.box.addEventListener("keydown", function(e) {
		if(e.key === "Escape" && kphcIsTrusted(e)) {
			e.preventDefault();
			cipPassword.closeDialog();
		}
	});

	document.documentElement.appendChild(d.host);
	cipPassword.dialog = d;
	return d;
}

cipPassword.openDialog = function(field, iconHost) {
	var d = cipPassword.ensureDialog();
	d.field = field;
	var nextExists = Boolean(kphcData(field, "cip-genpw-next-field"));
	d.checkbox.checked = nextExists;
	d.checkbox.disabled = !nextExists;
	d.message.textContent = "";
	var r = iconHost.getBoundingClientRect();
	kphcStyle(d.box, {
		"left": Math.max(0, Math.round(r.left + r.width / 2 - 10)) + "px",
		"top": Math.round(r.bottom + 2) + "px"
	});
	kphcStyle(d.host, { "display": "block" });
	d.input.focus();
	if(d.input.value == "") {
		cipPassword.generate();
	}
}

cipPassword.closeDialog = function() {
	if(cipPassword.dialog) {
		kphcStyle(cipPassword.dialog.host, { "display": "none" });
	}
}

cipPassword.generate = function() {
	browser.runtime.sendMessage({
		action: "generate_password"
	}).then(cipPassword.callbackGeneratedPassword);
}

// Item 19: a copied password is removed from the clipboard after this time.
// The extension cannot read the clipboard (no clipboardRead permission), so it
// cannot check that the clipboard still holds the password. It skips the
// clear if the user copied or cut something else in this page meanwhile.
cipPassword.clipboardClearSeconds = 30;
cipPassword.clearTimer = null;
cipPassword.ownCopy = false;

document.addEventListener("copy", function() { cipPassword.onOtherCopy(); }, true);
document.addEventListener("cut", function() { cipPassword.onOtherCopy(); }, true);

cipPassword.onOtherCopy = function() {
	if(cipPassword.ownCopy || cipPassword.clearTimer === null) {
		return;
	}
	clearTimeout(cipPassword.clearTimer);
	cipPassword.clearTimer = null;
}

cipPassword.copyPasswordToClipboard = function() {
	var d = cipPassword.dialog;
	if(!d) {
		return false;
	}
	d.input.select();
	cipPassword.ownCopy = true;
	var success = false;
	try {
		success = document.execCommand("copy");
	}
	finally {
		cipPassword.ownCopy = false;
	}
	d.message.textContent = success
		? "Copied. The clipboard will be cleared in " + cipPassword.clipboardClearSeconds + " seconds."
		: "Could not copy to the clipboard.";
	kphcStyle(d.message, { "color": success ? "#2e6b2e" : "#b00020" });
	kphcStyle(d.btnClipboard, { "background": success ? "#3c9a3c" : "#f2f2f2", "color": success ? "#ffffff" : "#222222" });
	if(success) {
		cipPassword.scheduleClipboardClear();
	}
	return success;
}

cipPassword.scheduleClipboardClear = function() {
	if(cipPassword.clearTimer !== null) {
		clearTimeout(cipPassword.clearTimer);
	}
	cipPassword.clearTimer = setTimeout(function() {
		cipPassword.clearTimer = null;
		// Needs the clipboardWrite permission (no user action at this time).
		navigator.clipboard.writeText("").then(function() {
			var d = cipPassword.dialog;
			if(d && d.message.textContent.indexOf("Copied.") === 0) {
				d.message.textContent = "The clipboard was cleared.";
			}
		}, function() {});
	}, cipPassword.clipboardClearSeconds * 1000);
}

cipPassword.fillIn = function() {
	var d = cipPassword.dialog;
	var field = d && d.field;
	if(!field || !field.isConnected) {
		return;
	}
	var password = d.input.value;
	var warning = "";
	var max = parseInt(field.getAttribute("maxlength"), 10);
	if(max > 0 && password.length > max) {
		password = password.substring(0, max);
		d.input.value = password;
		warning = "The generated password was longer than the field allows.\nIt was cut to " + max + " characters. Please remember the new password.";
	}
	cip.setValueWithChange(field, password);
	var nextField = kphcData(field, "cip-genpw-next-field");
	if(d.checkbox.checked && nextField && nextField.isConnected) {
		cip.setValueWithChange(nextField, password);
	}
	cipPassword.copyPasswordToClipboard();
	if(warning) {
		d.message.textContent = warning + "\n" + d.message.textContent;
		kphcStyle(d.message, { "color": "#b00020" });
	}
}

cipPassword.callbackGeneratedPassword = function(entries) {
	var d = cipPassword.dialog;
	if(!d) {
		return;
	}
	if(entries && entries.length >= 1) {
		kphcStyle(d.btnClipboard, { "background": "#f2f2f2", "color": "#222222" });
		d.input.value = entries[0].Password;
		d.quality.textContent = isNaN(entries[0].Login) ? "??? Bits" : (entries[0].Login + " Bits");
		d.message.textContent = "";
	}
	else {
		d.message.textContent = "Cannot receive a generated password.\nIs KeePass running, and is KeePassHttp 2.3 or newer installed?";
	}
}

cipPassword.onRequestPassword = function() {
	cipPassword.generate();
}

cipPassword.checkObservedElements = function() {
	if(cipPassword.observingLock) {
		return;
	}
	cipPassword.observingLock = true;
	var icons = cipPassword.observedIcons.slice();
	for(var i = 0; i < icons.length; i++) {
		var icon = icons[i];
		var field = icon.field;
		if(!field || !field.isConnected) {
			cipPassword.removeIcon(icon);
		}
		else if(!kphcVisible(field)) {
			kphcStyle(icon.host, { "display": "none" });
		}
		else {
			kphcStyle(icon.host, { "display": "block" });
			cipPassword.setIconPosition(icon);
			kphcData(field, "cip-password-generator", true);
		}
	}
	cipPassword.observingLock = false;
}



var cipForm = {};

cipForm.init = function(form, credentialFields) {
	// TODO: could be called multiple times --> update credentialFields

	// not already initialized && password-field is not null
	if(form && !kphcData(form, "cipForm-initialized") && credentialFields.password) {
		kphcData(form, "cipForm-initialized", true);
		cipForm.setInputFields(form, credentialFields);
		form.addEventListener("submit", cipForm.onSubmit);
	}
}

cipForm.destroy = function(form, credentialFields) {
	if(form === false && credentialFields) {
		var field = _f(credentialFields.password) || _f(credentialFields.username);
		form = field ? field.closest("form") : null;
	}

	if(form) {
		form.removeEventListener("submit", cipForm.onSubmit);
		kphcData(form, "cipForm-initialized", false);
	}
}

cipForm.setInputFields = function(form, credentialFields) {
	kphcData(form, "cipUsername", credentialFields.username);
	kphcData(form, "cipPassword", credentialFields.password);
}

cipForm.onSubmit = function() {
	var usernameId = kphcData(this, "cipUsername");
	var passwordId = kphcData(this, "cipPassword");

	var usernameValue = "";
	var passwordValue = "";

	var usernameField = _f(usernameId);
	var passwordField = _f(passwordId);

	if(usernameField) {
		usernameValue = usernameField.value;
	}
	if(passwordField) {
		passwordValue = passwordField.value;
	}

	cip.rememberCredentials(usernameValue, passwordValue);
};



// "Choose own credential fields" (item 17c). Own code in a CLOSED shadow root,
// no jQuery UI: the page cannot read or click the chooser. Only real user
// clicks act. Styles via CSSOM (kphcStyle), so a page CSP does not block them.
var cipDefine = {};

cipDefine.selection = {
	"username": null,
	"password": null,
	"fields": {}
};
cipDefine.ui = null;
cipDefine.step = 1;

cipDefine.init = function () {
	cipDefine.close();

	cipFields.getAllFields();
	cipFields.prepareVisibleFieldsWithID("select");

	var ui = {};
	ui.host = document.createElement("kphc-chooser");
	kphcStyle(ui.host, { "all": "initial", "position": "absolute", "left": "0px", "top": "0px",
		"width": "0px", "height": "0px", "overflow": "visible", "z-index": "2147483645", "display": "block" });
	var root = ui.host.attachShadow({ mode: "closed" });

	ui.backdrop = document.createElement("div");
	kphcStyle(ui.backdrop, { "position": "fixed", "left": "0", "top": "0", "right": "0", "bottom": "0",
		"background": "rgba(0,0,0,0.75)", "z-index": "2147483645" });
	ui.fields = document.createElement("div");
	kphcStyle(ui.fields, { "position": "absolute", "left": "0px", "top": "0px", "z-index": "2147483646" });

	ui.box = document.createElement("div");
	ui.box.setAttribute("role", "dialog");
	ui.box.setAttribute("aria-label", "Choose own credential fields");
	kphcStyle(ui.box, { "position": "fixed", "left": "150px", "top": "100px", "z-index": "2147483647",
		"max-width": "420px", "padding": "8px 10px", "border": "2px solid #555555", "background": "rgba(40,40,40,0.92)",
		"color": "#efefef", "font": "14px Verdana, Arial, sans-serif", "text-align": "left" });
	ui.headline = document.createElement("div");
	kphcStyle(ui.headline, { "font-weight": "bold", "font-size": "160%", "padding-bottom": "8px", "cursor": "move" });
	ui.help = document.createElement("div");
	kphcStyle(ui.help, { "margin-bottom": "5px" });

	var btn = function(text, color) {
		var b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		kphcStyle(b, { "font": "13px Verdana, Arial, sans-serif", "padding": "3px 10px", "margin": "0 5px 0 0",
			"border": "1px solid #333333", "border-radius": "3px", "cursor": "pointer", "background": color, "color": "#ffffff" });
		return b;
	};
	ui.btnConfirm = btn("Confirm", "#2a6fd6");
	ui.btnSkip = btn("Skip", "#3a87ad");
	ui.btnAgain = btn("Again", "#c67605");
	ui.btnDismiss = btn("Dismiss", "#b00020");
	var buttons = document.createElement("div");
	buttons.appendChild(ui.btnConfirm);
	buttons.appendChild(ui.btnSkip);
	buttons.appendChild(ui.btnAgain);
	buttons.appendChild(ui.btnDismiss);

	ui.box.appendChild(ui.headline);
	ui.box.appendChild(ui.help);
	ui.box.appendChild(buttons);

	var origin = document.location.origin;
	if(cip.settings["defined-credential-fields"] && cip.settings["defined-credential-fields"][origin]) {
		var p = document.createElement("p");
		kphcStyle(p, { "margin": "10px 0 0 0", "padding-top": "10px", "border-top": "2px solid #666666" });
		p.appendChild(document.createTextNode("For this page credential fields are already selected and will be overwritten."));
		p.appendChild(document.createElement("br"));
		var discard = btn("Discard selection", "#b00020");
		kphcStyle(discard, { "margin-top": "5px" });
		p.appendChild(discard);
		ui.box.appendChild(p);
		cipDefine.onTrustedClick(discard, function() {
			delete cip.settings["defined-credential-fields"][origin];
			browser.runtime.sendMessage({
				action: 'save_defined_credential_fields',
				args: [null]
			});
			p.parentNode.removeChild(p);
		});
	}

	cipDefine.onTrustedClick(ui.btnDismiss, cipDefine.close);
	cipDefine.onTrustedClick(ui.btnSkip, function() {
		if(cipDefine.step == 1) {
			cipDefine.selection.username = null;
			cipDefine.prepareStep2();
		}
		else if(cipDefine.step == 2) {
			cipDefine.selection.password = null;
			cipDefine.prepareStep3();
		}
	});
	cipDefine.onTrustedClick(ui.btnAgain, function() {
		cipDefine.resetSelection();
		cipDefine.prepareStep1();
	});
	cipDefine.onTrustedClick(ui.btnConfirm, cipDefine.confirm);
	cipDefine.makeDraggable(ui.box, ui.headline);

	root.appendChild(ui.backdrop);
	root.appendChild(ui.fields);
	root.appendChild(ui.box);
	document.documentElement.appendChild(ui.host);
	cipDefine.ui = ui;

	cipDefine.resetSelection();
	cipDefine.prepareStep1();
}

cipDefine.onTrustedClick = function(el, fn) {
	el.addEventListener("click", function(e) {
		e.preventDefault();
		if(kphcIsTrusted(e) && !el.disabled) {
			fn.call(el, e);
		}
	});
}

// Move the instruction box with the mouse (it may cover a field).
cipDefine.makeDraggable = function(box, handle) {
	handle.addEventListener("mousedown", function(e) {
		if(!kphcIsTrusted(e)) {
			return;
		}
		e.preventDefault();
		var r = box.getBoundingClientRect();
		var dx = e.clientX - r.left;
		var dy = e.clientY - r.top;
		var move = function(ev) {
			kphcStyle(box, { "left": (ev.clientX - dx) + "px", "top": (ev.clientY - dy) + "px" });
		};
		var up = function() {
			window.removeEventListener("mousemove", move, true);
			window.removeEventListener("mouseup", up, true);
		};
		window.addEventListener("mousemove", move, true);
		window.addEventListener("mouseup", up, true);
	});
}

cipDefine.close = function() {
	if(cipDefine.ui && cipDefine.ui.host.parentNode) {
		cipDefine.ui.host.parentNode.removeChild(cipDefine.ui.host);
	}
	cipDefine.ui = null;
}

cipDefine.confirm = function() {
	if(!cip.settings["defined-credential-fields"]) {
		cip.settings["defined-credential-fields"] = {};
	}
	var username = cipDefine.selection.username ? cipFields.prepareId(cipDefine.selection.username) : null;
	var password = cipDefine.selection.password ? cipFields.prepareId(cipDefine.selection.password) : null;
	var fieldIds = Object.keys(cipDefine.selection.fields).map(function(id) { return cipFields.prepareId(id); });
	var origin = document.location.origin;
	cip.settings["defined-credential-fields"][origin] = {
		"username": username,
		"password": password,
		"fields": fieldIds
	};
	browser.runtime.sendMessage({
		action: 'save_defined_credential_fields',
		args: [cip.settings["defined-credential-fields"][origin]]
	});
	cipDefine.close();
}

cipDefine.resetSelection = function() {
	cipDefine.selection = {
		username: null,
		password: null,
		fields: {}
	};
}

cipDefine.isFieldSelected = function(cipId) {
	return (
		cipId == cipDefine.selection.username ||
		cipId == cipDefine.selection.password ||
		cipId in cipDefine.selection.fields
	);
}

cipDefine.setButtons = function(show) {
	var ui = cipDefine.ui;
	kphcStyle(ui.btnConfirm, { "display": show.confirm ? "inline-block" : "none" });
	kphcStyle(ui.btnSkip, { "display": show.skip ? "inline-block" : "none" });
	kphcStyle(ui.btnAgain, { "display": show.again ? "inline-block" : "none" });
}

// Remove the clickable boxes, except those already chosen (kind in keep).
cipDefine.clearMarks = function(keep) {
	var marks = cipDefine.ui.fields.querySelectorAll("[data-kphc-field]");
	for(var i = 0; i < marks.length; i++) {
		if(keep.indexOf(marks[i].getAttribute("data-kphc-chosen")) < 0) {
			marks[i].parentNode.removeChild(marks[i]);
		}
	}
}

cipDefine.prepareStep1 = function() {
	cipDefine.step = 1;
	cipDefine.clearMarks([]);
	cipDefine.ui.headline.textContent = "1. Choose a username field";
	cipDefine.ui.help.textContent = "";
	cipDefine.setButtons({ skip: true });
	cipDefine.markFields(cipFields.inputQueryPattern, "username", "Username", "#32cd32");
}

cipDefine.prepareStep2 = function() {
	cipDefine.step = 2;
	cipDefine.clearMarks(["username"]);
	cipDefine.ui.headline.textContent = "2. Now choose a password field";
	cipDefine.ui.help.textContent = "";
	cipDefine.setButtons({ skip: true, again: true });
	cipDefine.markFields("input[type='password']", "password", "Password", "#ff0000");
}

cipDefine.prepareStep3 = function() {
	cipDefine.step = 3;
	cipDefine.clearMarks(["username", "password"]);
	cipDefine.ui.headline.textContent = "3. Confirm selection";
	cipDefine.ui.help.textContent = "Please confirm your selection or choose more fields as string fields.";
	cipDefine.setButtons({ confirm: true, again: true });
	cipDefine.ui.btnConfirm.disabled = !cipDefine.selection.username && !cipDefine.selection.password;
	kphcStyle(cipDefine.ui.btnConfirm, { "opacity": cipDefine.ui.btnConfirm.disabled ? "0.5" : "1" });
	cipDefine.markFields(cipFields.inputQueryPattern + ", select", "string", null, "#1e90ff");
}

// One clickable box over each visible field that is not chosen yet.
cipDefine.markFields = function(pattern, kind, label, color) {
	document.querySelectorAll(pattern).forEach(function(el) {
		var id = el.getAttribute("data-cip-id");
		if(!id || cipDefine.isFieldSelected(id)) {
			return;
		}
		if(!kphcVisible(el)) {
			return;
		}
		var r = el.getBoundingClientRect();
		var mark = document.createElement("div");
		mark.setAttribute("data-kphc-field", id);
		mark.setAttribute("role", "button");
		kphcStyle(mark, { "position": "absolute", "box-sizing": "border-box", "cursor": "pointer",
			"left": Math.round(r.left + window.scrollX) + "px", "top": Math.round(r.top + window.scrollY) + "px",
			"width": Math.round(r.width) + "px", "height": Math.round(r.height) + "px",
			"border": "2px solid #efefef", "background": "rgba(239,239,239,0.4)",
			"font": "bold 12px Verdana, Arial, sans-serif", "color": "#efefef", "text-align": "left" });
		mark.addEventListener("mouseenter", function() {
			if(!mark.hasAttribute("data-kphc-chosen")) {
				kphcStyle(mark, { "border-color": "orange" });
			}
		});
		mark.addEventListener("mouseleave", function() {
			if(!mark.hasAttribute("data-kphc-chosen")) {
				kphcStyle(mark, { "border-color": "#efefef" });
			}
		});
		cipDefine.onTrustedClick(mark, function() {
			if(mark.hasAttribute("data-kphc-chosen")) {
				return;
			}
			mark.setAttribute("data-kphc-chosen", kind);
			kphcStyle(mark, { "border-color": color, "background": "rgba(0,0,0,0.25)" });
			if(kind == "username") {
				cipDefine.selection.username = id;
				mark.textContent = label;
				cipDefine.prepareStep2();
			}
			else if(kind == "password") {
				cipDefine.selection.password = id;
				mark.textContent = label;
				cipDefine.prepareStep3();
			}
			else {
				cipDefine.selection.fields[id] = true;
				mark.textContent = "String field #" + Object.keys(cipDefine.selection.fields).length;
				cipDefine.ui.btnConfirm.disabled = false;
				kphcStyle(cipDefine.ui.btnConfirm, { "opacity": "1" });
			}
		});
		cipDefine.ui.fields.appendChild(mark);
	});
}


var cipFields = {}

cipFields.inputQueryPattern = "input[type='text'], input[type='email'], input[type='username'], input[type='password'], input[type='tel'], input[type='number'], input:not([type])";
// unique number as new IDs for input fields
cipFields.uniqueNumber = 342845638;
// objects with combination of username + password fields
cipFields.combinations = [];

cipFields.setUniqueId = function(field) {
	if(field && !field.getAttribute("data-cip-id")) {
		// use ID of field if it is unique
		// yes, it should be, but there are many bad developers outside...
		var fieldId = field.getAttribute("id");
		if(fieldId) {
			var same = 0;
			document.querySelectorAll("input[id]").forEach(function(el) {
				if(el.getAttribute("id") === fieldId) {
					same++;
				}
			});
			if(same == 1) {
				field.setAttribute("data-cip-id", fieldId);
				return;
			}
		}

		// create own ID if no ID is set for this field (same prefix as before:
		// saved field choices keep working)
		cipFields.uniqueNumber += 1;
		field.setAttribute("data-cip-id", "cIPJQ"+String(cipFields.uniqueNumber));
	}
}

// Escaped id of a field, as used in combinations, or null.
cipFields.idOf = function(field) {
	if(!field) {
		return null;
	}
	cipFields.setUniqueId(field);
	return cipFields.prepareId(field.getAttribute("data-cip-id"));
}

cipFields.isPasswordInput = function(field) {
	var t = field && field.getAttribute("type");
	return !!t && t.toLowerCase() == "password";
}

cipFields.prepareId = function(id) {
	return id.replace(/[:#.,\[\]\(\)' "]/g, function(m) {
												return "\\"+m
											});
}

cipFields.getAllFields = function() {
	var fields = [];
	// get all input fields which are text, email or password and visible
	document.querySelectorAll(cipFields.inputQueryPattern).forEach(function(el) {
		if(kphcVisible(el)) {
			cipFields.setUniqueId(el);
			fields.push(el);
		}
	});

	_detectedFields = fields.length;

	return fields;
}

cipFields.prepareVisibleFieldsWithID = function(pattern) {
	document.querySelectorAll(pattern).forEach(function(el) {
		if(kphcVisible(el)) {
			cipFields.setUniqueId(el);
		}
	});
}

cipFields.getAllCombinations = function(inputs) {
	var fields = [];
	var uField = null;
	for(var i = 0; i < inputs.length; i++) {
		if(!inputs[i]) {
			continue;
		}

		if(cipFields.isPasswordInput(inputs[i])) {
			var uId = uField ? cipFields.prepareId(uField.getAttribute("data-cip-id")) : null;

			var combination = {
				"username": uId,
				"password": cipFields.prepareId(inputs[i].getAttribute("data-cip-id"))
			};
			fields.push(combination);

			// reset selected username field
			uField = null;
		}
		else {
			// username field
			uField = inputs[i];
		}
	}

	return fields;
}

cipFields.getCombination = function(givenType, fieldId) {
	if(cipFields.combinations.length == 0) {
		if(cipFields.useDefinedCredentialFields()) {
			return cipFields.combinations[0];
		}
	}
	// use defined credential fields (already loaded into combinations)
	if(cip.settings["defined-credential-fields"] && cip.settings["defined-credential-fields"][document.location.origin]) {
		return cipFields.combinations[0];
	}

	for(var i = 0; i < cipFields.combinations.length; i++) {
		if(cipFields.combinations[i][givenType] == fieldId) {
			return cipFields.combinations[i];
		}
	}

	// find new combination
	var combination = {
		"username": null,
		"password": null
	};

	var newCombi = false;
	if(givenType == "username") {
		var passwordField = cipFields.getPasswordField(fieldId, true);
		var passwordId = null;
		if(passwordField) {
			passwordId = cipFields.prepareId(passwordField.getAttribute("data-cip-id"));
		}
		combination = {
			"username": fieldId,
			"password": passwordId
		};
		newCombi = true;
	}
	else if(givenType == "password") {
		var usernameField = cipFields.getUsernameField(fieldId, true);
		var usernameId = null;
		if(usernameField) {
			usernameId = cipFields.prepareId(usernameField.getAttribute("data-cip-id"));
		}
		combination = {
			"username": usernameId,
			"password": fieldId
		};
		newCombi = true;
	}

	if(combination.username || combination.password) {
		cipFields.combinations.push(combination);
	}

	if(combination.username) {
		if(cip.credentials.length > 0) {
			cip.preparePageForMultipleCredentials(cip.credentials);
		}
	}

	if(newCombi) {
		combination.isNew = true;
	}
	return combination;
}

/**
* return the username field or null if it not exists
*/
cipFields.getUsernameField = function(passwordId, checkDisabled) {
	var passwordField = _f(passwordId);
	if(!passwordField) {
		return null;
	}

	var form = passwordField.closest("form");
	var usernameField = null;
	var passwordRaw = kphcUnescapeId(passwordId);

	// search all inputs on this one form
	if(form) {
		var inForm = form.querySelectorAll(cipFields.inputQueryPattern);
		for(var j = 0; j < inForm.length; j++) {
			cipFields.setUniqueId(inForm[j]);
			if(inForm[j].getAttribute("data-cip-id") == passwordRaw) {
				break;
			}
			if(cipFields.isPasswordInput(inForm[j])) {
				continue;
			}
			usernameField = inForm[j];
		}
	}
	// search all inputs on page
	else {
		var inputs = cipFields.getAllFields();
		cip.initPasswordGenerator(inputs);
		for(var i = 0; i < inputs.length; i++) {
			if(inputs[i].getAttribute("data-cip-id") == passwordRaw) {
				break;
			}

			if(cipFields.isPasswordInput(inputs[i])) {
				continue;
			}

			usernameField = inputs[i];
		}
	}

	if(usernameField && !checkDisabled) {
		var usernameId = usernameField.getAttribute("data-cip-id");
		// check if usernameField is already used by another combination
		for(var i = 0; i < cipFields.combinations.length; i++) {
			if(cipFields.combinations[i].username == usernameId) {
				usernameField = null;
				break;
			}
		}
	}

	cipFields.setUniqueId(usernameField);

	return usernameField;
}

/**
* return the password field or null if it not exists
*/
cipFields.getPasswordField = function(usernameId, checkDisabled) {
	var usernameField = _f(usernameId);
	if(!usernameField) {
		return null;
	}

	var form = usernameField.closest("form");
	var passwordField = null;
	var usernameRaw = kphcUnescapeId(usernameId);

	// search all inputs on this one form
	if(form) {
		passwordField = form.querySelector("input[type='password']");

		if(cip.settings.usePasswordGenerator === true) {
			cipPassword.init();
			cipPassword.initField(passwordField);
		}
	}
	// search all inputs on page
	else {
		var inputs = cipFields.getAllFields();
		cip.initPasswordGenerator(inputs);

		var active = false;
		for(var i = 0; i < inputs.length; i++) {
			if(inputs[i].getAttribute("data-cip-id") == usernameRaw) {
				active = true;
			}
			if(active && cipFields.isPasswordInput(inputs[i])) {
				passwordField = inputs[i];
				break;
			}
		}
	}

	if(passwordField && !checkDisabled) {
		var passwordId = passwordField.getAttribute("data-cip-id");
		// check if passwordField is already used by another combination
		for(var i = 0; i < cipFields.combinations.length; i++) {
			if(cipFields.combinations[i].password == passwordId) {
				passwordField = null;
				break;
			}
		}
	}

	cipFields.setUniqueId(passwordField);

	return passwordField;
}

cipFields.prepareCombinations = function(combinations) {
	for(var i = 0; i < combinations.length; i++) {
		var pwField = _f(combinations[i].password);
		// needed for auto-complete: don't overwrite manually filled-in password field
		if(pwField && !kphcData(pwField, "cipFields-onChange")) {
			kphcData(pwField, "cipFields-onChange", true);
			pwField.addEventListener("change", function() {
				kphcData(this, "unchanged", false);
			});
		}

		// initialize form-submit for remembering credentials
		var fieldId = combinations[i].password || combinations[i].username;
		var field = _f(fieldId);
		if(field) {
			var form = field.closest("form");
			if(form) {
				cipForm.init(form, combinations[i]);
			}
		}
	}
}

cipFields.useDefinedCredentialFields = function() {
	if(cip.settings["defined-credential-fields"] && cip.settings["defined-credential-fields"][document.location.origin]) {
		var creds = cip.settings["defined-credential-fields"][document.location.origin];

		var $found = _f(creds.username) || _f(creds.password);
		for(var i = 0; i < creds.fields.length; i++) {
			if(_fs(creds.fields[i])) {
				$found = true;
				break;
			}
		}

		if($found) {
			var fields = {
				"username": creds.username,
				"password": creds.password,
				"fields": creds.fields
			};
			cipFields.combinations = [];
			cipFields.combinations.push(fields);

			return true;
		}
	}

	return false;
}



var cip = {};

// settings of KeePassHttp-Neo
cip.settings = {};
// username field which will be set on focus
cip.u = null;
// password field which will be set on focus
cip.p = null;
// document.location
cip.url = null;
// request-url of the form in which the field is located
cip.submitUrl = null;
// received credentials from KeePassHTTP
cip.credentials = [];

// Watches for login fields that appear later (kphcObserver, no polling). Only
// started when the first init found no credential fields (else it re-initialised
// the same fields: double request, double fill).
cip.detectNewActiveFields = function() {
	kphcObserver.wantDetect = true;
	kphcObserver.update();
};

cip.checkNewFields = function() {
	const fields = cipFields.getAllFields();
	// If only password field is shown it's enough to have one field visible for initCredentialFields
	if (fields.length > (_detectedFields == 1 ? 0 : 1)) {
		kphcObserver.wantDetect = false;
		cip.initCredentialFields(true);
	}
};

// Single entry point for page start. Safe to call more than once.
cip.started = false;
cip.start = function() {
	if(cip.started) {
		return;
	}
	cip.started = true;
	cip.init().then(function(found) {
		if(found === false) {
			cip.detectNewActiveFields();
		}
	});
}

// Resolves to true/false (credential fields found or not), or null if skipped.
cip.init = function() {
	return browser.runtime.sendMessage({
		"action": "load_settings",
	}).then(function(settings) {
		cip.settings = settings;
		return cip.initCredentialFields();
	});
}

// One retrieve_credentials at a time per page: a second caller gets the
// pending request instead of sending a new one.
// dontAutoFillIn: true = only fill the dropdown, do not auto-fill the fields.
cip.retrieveInFlight = null;
cip.autoFilled = false;
// Set when KeePass was locked: the next trusted focus of a username field fetches again.
cip.refetchOnFocus = false;
cip.retrieveCredentials = function(dontAutoFillIn) {
	if(cip.retrieveInFlight) {
		return cip.retrieveInFlight;
	}
	var p = browser.runtime.sendMessage({
		'action': 'retrieve_credentials',
		// The background takes the page URL from Firefox, not from here.
		'args': [ null, cip.submitUrl ]
	}).then(function(credentials) {
		return cip.retrieveCredentialsCallback(credentials, dontAutoFillIn);
	});
	var done = function() {
		if(cip.retrieveInFlight === p) {
			cip.retrieveInFlight = null;
		}
	};
	cip.retrieveInFlight = p;
	p.then(done, done);
	// The background does not always answer (e.g. not connected): do not block forever.
	setTimeout(done, 15000);
	return p;
}

// Resolves to true/false (credential fields found or not), or null if skipped.
cip.initCredentialFields = function(forceCall) {
	if(_called.initCredentialFields && !forceCall) {
		return Promise.resolve(null);
	}
	_called.initCredentialFields = true;

	return browser.runtime.sendMessage({ 'action': 'page_clear_logins' }).then(() => {
		var inputs = cipFields.getAllFields();
		cipFields.prepareVisibleFieldsWithID("select");
		cip.initPasswordGenerator(inputs);

		if(!cipFields.useDefinedCredentialFields()) {
			// get all combinations of username + password fields
			cipFields.combinations = cipFields.getAllCombinations(inputs);
		}
		cipFields.prepareCombinations(cipFields.combinations);

		if(cipFields.combinations.length == 0) {
			browser.runtime.sendMessage({
				'action': 'show_default_browseraction'
			});
			return false;
		}

		cip.url = document.location.origin;
		cip.submitUrl = cip.getFormActionUrl(cipFields.combinations[0]);

		if(cip.settings.autoRetrieveCredentials === true) {
			cip.retrieveCredentials();
		}
		return true;
	});
} // end function init

cip.initPasswordGenerator = function(inputs) {
	if(cip.settings.usePasswordGenerator === true) {
		cipPassword.init();

		for(var i = 0; i < inputs.length; i++) {
			if(inputs[i] && cipFields.isPasswordInput(inputs[i])) {
				cipPassword.initField(inputs[i], inputs, i);
			}
		}
	}
}

cip.receiveCredentialsIfNecessary = function () {
	if(cip.credentials.length == 0) {
		cip.retrieveCredentials();
	}
}

cip.retrieveCredentialsCallback = function (credentials, dontAutoFillIn) {
	if (!Array.isArray(credentials)) {
		return;
	}
	if (cipFields.combinations.length > 0) {
		cip.u = _f(cipFields.combinations[0].username);
		cip.p = _f(cipFields.combinations[0].password);
	}

	if (credentials.length > 0) {
		cip.credentials = credentials;
		cip.prepareFieldsForCredentials(!Boolean(dontAutoFillIn));
	}
}

cip.insecureWarningText = "Not secure: this page or its login form does not use https. Passwords can be read by others on the network.";

// True if the page is not https (loopback hosts excepted, the traffic stays on
// this computer) or the form sends to a not-https address. On such pages we
// never auto-fill; the user can still choose a login from the (red) dropdown.
cip.isLoopbackHost = function(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
cip.isInsecureUrl = function(url) {
	try {
		var u = new URL(url);
		return u.protocol !== "https:" && !cip.isLoopbackHost(u.hostname);
	}
	catch (e) {
		return true;
	}
}
cip.isInsecurePage = function() {
	return cip.isInsecureUrl(document.location.href) || (!!cip.submitUrl && cip.isInsecureUrl(cip.submitUrl));
}

cip.prepareFieldsForCredentials = function(autoFillInForSingle) {
	// never auto-fill on a not-secure page: show the (red) dropdown instead
	autoFillInForSingle = autoFillInForSingle && !cip.isInsecurePage();
	// only one login for this site
	if (autoFillInForSingle && cip.settings.autoFillSingleEntry === true && cip.credentials.length == 1) {
		cip.autoFilled = true;
		var combination = null;
		if(!cip.p && !cip.u && cipFields.combinations.length > 0) {
			cip.u = _f(cipFields.combinations[0].username);
			cip.p = _f(cipFields.combinations[0].password);
			combination = cipFields.combinations[0];
		}
		if (cip.u) {
			combination = cipFields.getCombination("username", cipFields.idOf(cip.u));
		}
		if (cip.p) {
			combination = cipFields.getCombination("password", cipFields.idOf(cip.p));
		}
		cip.fillEntry(0, cip.u, cip.p, combination ? combination.fields : null, {});

		// generate popup-list of usernames + descriptions
		browser.runtime.sendMessage({
			'action': 'popup_login',
			'args': [[cip.credentials[0].Login + " (" + cip.credentials[0].Name + ")"]]
		});
	}
	//multiple logins for this site
	else if (cip.credentials.length > 1 || (cip.credentials.length > 0 && (!(cip.settings.autoFillSingleEntry === true) || !autoFillInForSingle))) {
		cip.preparePageForMultipleCredentials(cip.credentials);
	}
}

cip.preparePageForMultipleCredentials = function(credentials) {
	// add usernames + descriptions to autocomplete-list and popup-list
	var usernames = [];
	cipAutocomplete.elements = [];
	var visibleLogin;
	for(var i = 0; i < credentials.length; i++) {
		visibleLogin = (credentials[i].Login.length > 0) ? credentials[i].Login : "- no username -";
		usernames.push(visibleLogin + " (" + credentials[i].Name + ")");
		var item = {
			"label": visibleLogin + " (" + credentials[i].Name + ")",
			"value": credentials[i].Login,
			"loginId": i
		};
		cipAutocomplete.elements.push(item);
	}

	// generate popup-list of usernames + descriptions
	browser.runtime.sendMessage({
		'action': 'popup_login',
		'args': [usernames]
	});

	// initialize autocomplete for username fields
	if(cip.settings.autoCompleteUsernames === true) {
		for (const combo of cipFields.combinations) {
			// Both username and password fields are visible
			if (_detectedFields >= 2) {
				if (_f(combo.username)) {
					cipAutocomplete.init(_f(combo.username));
				}
			} else if (_detectedFields == 1) {
				// If only password field is the visible one
				if (_f(combo.password)) {
					cipAutocomplete.init(_f(combo.password));
				}
			}
		}
	}
}

cip.getFormActionUrl = function(combination) {
	var field = _f(combination.password) || _f(combination.username);

	if(field == null) {
		return null;
	}

	var form = field.closest("form");
	var action = null;

	if(form) {
		action = form.action;
	}

	if(typeof(action) != "string" || action == "") {
		action = document.location.origin + document.location.pathname;
	}

	return action;
}

cip.fillInCredentials = function(combination, onlyPassword, suppressWarnings) {
	var action = cip.getFormActionUrl(combination);

	var u = _f(combination.username);
	var p = _f(combination.password);

	if(combination.isNew) {
		// initialize form-submit for remembering credentials
		var fieldId = combination.password || combination.username;
		var field = _f(fieldId);
		if(field) {
			var form2 = field.closest("form");
			if(form2) {
				cipForm.init(form2, combination);
			}
		}
	}

	if(u) {
		cip.u = u;
	}
	if(p) {
		cip.p = p;
	}

	if(cip.url == document.location.origin && cip.submitUrl == action && cip.credentials.length > 0) {
		cip.fillIn(combination, onlyPassword, suppressWarnings);
	}
	else {
		cip.url = document.location.origin;
		cip.submitUrl = action;

		browser.runtime.sendMessage({
			'action': 'retrieve_credentials',
			'args': [ null, cip.submitUrl, false, true ]
		}).then(function(credentials) {
			cip.retrieveCredentialsCallback(credentials, true);
			cip.fillIn(combination, onlyPassword, suppressWarnings);
		});
	}
}

cip.fillInFromActiveElement = function(suppressWarnings) {
	var el = document.activeElement;
	if (el.tagName.toLowerCase() != "input") {
		if(cipFields.combinations.length > 0) {
			cip.fillInCredentials(cipFields.combinations[0], false, suppressWarnings);
		}
		return;
	}

	var fieldId = cipFields.idOf(el);
	var combination = null;
	if(el.type && el.type.toLowerCase() == "password") {
		combination = cipFields.getCombination("password", fieldId);
	}
	else {
		combination = cipFields.getCombination("username", fieldId);
	}
	delete combination.loginId;

	cip.fillInCredentials(combination, false, suppressWarnings);
}

cip.fillInFromActiveElementPassOnly = function(suppressWarnings) {
	var el = document.activeElement;
	if (el.tagName.toLowerCase() != "input") {
		if(cipFields.combinations.length > 0) {
			cip.fillInCredentials(cipFields.combinations[0], false, suppressWarnings);
		}
		return;
	}

	var fieldId = cipFields.idOf(el);
	var combination = null;
	if(el.type && el.type.toLowerCase() == "password") {
		combination = cipFields.getCombination("password", fieldId);
	}
	else {
		combination = cipFields.getCombination("username", fieldId);
	}

	if(!_f(combination.password)) {
		var message = "Unable to find a password field";
		browser.runtime.sendMessage({
			action: 'alert',
			args: [message]
		});
		return;
	}

	delete combination.loginId;

	cip.fillInCredentials(combination, true, suppressWarnings);
}

cip.setValue = function(field, value) {
	if(field.tagName === "SELECT") {
		value = String(value).toLowerCase().trim();
		var options = field.options;
		for(var i = 0; i < options.length; i++) {
			if(options[i].text.toLowerCase().trim() == value) {
				cip.setValueWithChange(field, options[i].value);
				break;
			}
		}
	}
	else {
		cip.setValueWithChange(field, value);
	}
}

cip.fillInStringFields = function(fields, StringFields, filledInFields) {
	var $filledIn = false;

	filledInFields.list = [];
	if(fields && StringFields && fields.length > 0 && StringFields.length > 0) {
		for(var i = 0; i < fields.length; i++) {
			var $sf = _fs(fields[i]);
			if($sf && StringFields[i]) {
				//$sf.val(StringFields[i].Value);
				cip.setValue($sf, StringFields[i].Value);
				filledInFields.list.push(fields[i]);
				$filledIn = true;
			}
		}
	}

	return $filledIn;
}

cip.setValueWithChange = function(field, value) {

	value = String(value);
	if (cip.settings.respectMaxLength === true) {
		// Before: "$.isNumeric" threw here ($ is not defined in the content script).
		var maxlength = field.getAttribute("maxlength");
		if (maxlength !== null && /^\d+$/.test(maxlength.trim()) && parseInt(maxlength, 10) > 0) {
			value = value.substring(0, parseInt(maxlength, 10));
		}
	}

	field.value = value;
	field.dispatchEvent(new Event('input', {'bubbles': true}));
	field.dispatchEvent(new Event('change', {'bubbles': true}));
}

// Fills login, password and string fields of entry i. The password is not in
// the page: it is asked from the background now, by the entry's SecretRef
// (item 16). opts: onlyPassword (do not set the login), forcePasswordType,
// markUnchanged. Resolves to true if a field was filled.
cip.getSecret = function(entry) {
	if (!entry || typeof entry.SecretRef !== "string") {
		return Promise.resolve(null);
	}
	return browser.runtime.sendMessage({ 'action': 'get_secret', 'args': [entry.SecretRef] }).catch(function() { return null; });
}

cip.fillEntry = async function(i, uField, pField, stringFieldIds, opts) {
	var entry = cip.credentials[i];
	var secret = await cip.getSecret(entry);
	if (!secret || cip.credentials[i] !== entry) {
		return false;
	}
	var filledIn = false;
	if (uField && !opts.onlyPassword) {
		cip.setValueWithChange(uField, entry.Login);
		filledIn = true;
	}
	if (pField) {
		if (opts.forcePasswordType) {
			pField.setAttribute("type", "password");
		}
		cip.setValueWithChange(pField, secret.Password);
		if (opts.markUnchanged) {
			kphcData(pField, "unchanged", true);
		}
		filledIn = true;
	}
	var list = {};
	if (cip.fillInStringFields(stringFieldIds, secret.StringFields, list)) {
		cipForm.destroy(false, {"password": list.list[0], "username": list.list[1]});
		filledIn = true;
	}
	return filledIn;
}

cip.fillIn = async function(combination, onlyPassword, suppressWarnings) {
	// no credentials available
	if (cip.credentials.length == 0 && !suppressWarnings) {
		var message = "No logins found.";
		browser.runtime.sendMessage({
			action: 'alert',
			args: [message]
		});
		return;
	}

	var uField = _f(combination.username);
	var pField = _f(combination.password);

	// exactly one pair of credentials available
	if (cip.credentials.length == 1) {
		var filledIn = await cip.fillEntry(0, uField, pField, combination.fields,
			{ onlyPassword: onlyPassword, forcePasswordType: true, markUnchanged: true });

		if(!filledIn) {
			if(!suppressWarnings) {
				var message = "Error #101\nCannot find fields to fill in.";
				browser.runtime.sendMessage({
					action: 'alert',
					args: [message]
				});
			}
		}
	}
	// specific login id given
	else if(combination.loginId != undefined && cip.credentials[combination.loginId]) {
		var filledIn = await cip.fillEntry(combination.loginId, uField, pField, combination.fields,
			{ markUnchanged: true });

		if(!filledIn) {
			if(!suppressWarnings) {
				var message = "Error #102\nCannot find fields to fill in.";
				browser.runtime.sendMessage({
					action: 'alert',
					args: [message]
				});
			}
		}
	}
	// multiple credentials available
	else {
		// check if only one password for given username exists
		var countPasswords = 0;

		if(uField) {
			var valIndex = -1;
			var valQueryUsername = uField.value.toLowerCase();

			// find passwords to given username (even those with empty username)
			for (var i = 0; i < cip.credentials.length; i++) {
				if(cip.credentials[i].Login.toLowerCase() == valQueryUsername) {
					countPasswords += 1;
					valIndex = i;
				}
			}

			// for the correct alert message: 0 = no logins, X > 1 = too many logins
			if(countPasswords == 0) {
				countPasswords = cip.credentials.length;
			}

			// only one mapping username found
			if(countPasswords == 1) {
				await cip.fillEntry(valIndex, uField, pField, combination.fields,
					{ onlyPassword: onlyPassword, markUnchanged: true });
			}

			// user has to select correct credentials by himself
			if(countPasswords > 1) {
				if(!suppressWarnings) {
					var message = "Error #105\nMore than one login was found in KeePass!\n" +
					"Press the KeePassHttp-Neo icon for more options.";
					browser.runtime.sendMessage({
						action: 'alert',
						args: [message]
					});
				}
			}
			else if(countPasswords < 1) {
				if(!suppressWarnings) {
					var message = "Error #103\nNo credentials for given username found.";
					browser.runtime.sendMessage({
						action: 'alert',
						args: [message]
					});
				}
			}
		}
		else {
			if(!suppressWarnings) {
					var message = "Error #104\nMore than one login was found in KeePass!\n" +
					"Press the KeePassHttp-Neo icon for more options.";
				browser.runtime.sendMessage({
					action: 'alert',
					args: [message]
				});
			}
		}
	}
}

cip.contextMenuRememberCredentials = function() {
	var el = document.activeElement;
	if (el.tagName.toLowerCase() != "input") {
		return;
	}

	var fieldId = cipFields.idOf(el);
	var combination = null;
	if(el.type && el.type.toLowerCase() == "password") {
		combination = cipFields.getCombination("password", fieldId);
	}
	else {
		combination = cipFields.getCombination("username", fieldId);
	}

	var usernameValue = "";
	var passwordValue = "";

	var usernameField = _f(combination.username);
	var passwordField = _f(combination.password);

	if(usernameField) {
		usernameValue = usernameField.value;
	}
	if(passwordField) {
		passwordValue = passwordField.value;
	}

	if(!cip.rememberCredentials(usernameValue, passwordValue)) {
		alert("Could not detect changed credentials.");
	}
};

cip.rememberCredentials = function(usernameValue, passwordValue) {
	// no password given or field cleaned by a site-running script
	// --> no password to save
	if(passwordValue == "") {
		return false;
	}

	// The background adds the page URL (from Firefox) and the list of known
	// entries for this frame. It does not trust values from the page. The page
	// has no passwords (item 16), so the background also drops a login that is
	// already in KeePass unchanged.
	browser.runtime.sendMessage({
		'action': 'set_remember_credentials',
		'args': [usernameValue, passwordValue]
	});

	return true;
};

// Start after this script has run (the content script runs at document_idle,
// so the DOM is ready).
Promise.resolve().then(function() {
	if (!kphcSandboxed) {
		cip.start();
	}
});

var cipEvents = {};

cipEvents.clearCredentials = function() {
	cip.credentials = [];
	cipAutocomplete.elements = [];

	if(cip.settings.autoCompleteUsernames === true) {
		for(var i = 0; i < cipFields.combinations.length; i++) {
			var uField = _f(cipFields.combinations[i].username);
			if(uField) {
				cipAutocomplete.disable(uField);
			}
		}
	}
}

// Tab became active. Leaving a tab clears its credentials (background
// "clear_credentials"), so fetch again for the dropdown, but do not auto-fill
// again if this page was already auto-filled (before, every tab switch filled
// the fields again). If KeePass was locked at load, the first fill happens now.
cipEvents.triggerActivatedTab = function() {
	if(!cip.started) {
		cip.start();
		return;
	}
	if(!_called.initCredentialFields) {
		return; // first init still running
	}

	browser.runtime.sendMessage({
		"action": "load_settings",
	}).then(function(settings) {
		cip.settings = settings;
		if((cip.url || cip.submitUrl) && cipFields.combinations.length > 0 && cip.settings.autoRetrieveCredentials === true
			&& cip.credentials.length == 0) {
			cip.retrieveCredentials(cip.autoFilled);
		}
	});
}
