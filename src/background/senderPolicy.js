// Who may send which message, and which values the background trusts.
//
// Content scripts run inside web pages. A bug in the page-facing code (or in
// jQuery) could let a page send any message the content script can send. So:
// - content scripts may only use the small set of actions they need;
// - the page URL always comes from Firefox (sender.url / sender.frameId),
//   never from the message;
// - extension pages (popup, options) may use every action.
var senderPolicy = {};

// Actions a content script (kphc.js) may send.
senderPolicy.contentActions = {
	"alert": true,
	"generate_password": true,
	"load_settings": true,
	"page_clear_logins": true,
	"popup_login": true,
	"retrieve_credentials": true,
	"save_defined_credential_fields": true,
	"set_remember_credentials": true,
	"show_default_browseraction": true
};

senderPolicy.maxStringLength = 4096;
senderPolicy.maxListLength = 500;

// "extension": popup/options page of this extension.
// "content": a content script in a web page tab.
// null: reject.
senderPolicy.classify = function(sender, ownId, ownBaseUrl) {
	if(!sender || sender.id !== ownId) {
		return null;
	}
	if(typeof sender.url === "string" && sender.url.indexOf(ownBaseUrl) === 0) {
		return "extension";
	}
	if(sender.tab && typeof sender.tab.id === "number" && sender.tab.id >= 0 && typeof sender.frameId === "number") {
		return "content";
	}
	return null;
}

senderPolicy.isAllowed = function(kind, action) {
	if(kind === "extension") {
		return true;
	}
	if(kind === "content") {
		return Object.prototype.hasOwnProperty.call(senderPolicy.contentActions, action);
	}
	return false;
}

// True if the message comes from an iframe whose origin differs from the
// top page of the tab (ads, widgets, a hostile page framing a login).
// Both URLs come from Firefox. Unknown values count as cross-origin.
senderPolicy.isCrossOriginFrame = function(sender) {
	if(sender.frameId === 0) {
		return false;
	}
	var frame = senderPolicy.frameOrigin(sender.url);
	var top = senderPolicy.frameOrigin(sender.tab && sender.tab.url);
	return !frame || !top || frame !== top;
}

// Actions refused to cross-origin iframes: no logins in, no logins out.
senderPolicy.topOriginOnlyActions = {
	"popup_login": true,
	"retrieve_credentials": true,
	"set_remember_credentials": true
};

// Parsed http(s) URL of the sending frame, or null.
senderPolicy.webUrl = function(url) {
	try {
		var u = new URL(url);
		if(u.protocol === "http:" || u.protocol === "https:") {
			return u;
		}
	}
	catch (e) {}
	return null;
}

// "https://host:port" of the sending frame, or null.
senderPolicy.frameOrigin = function(senderUrl) {
	var u = senderPolicy.webUrl(senderUrl);
	return u ? u.origin : null;
}

// URL saved with a new entry: origin + path of the sending frame (no query,
// no fragment: they can hold session tokens).
senderPolicy.saveUrl = function(senderUrl) {
	var u = senderPolicy.webUrl(senderUrl);
	return u ? u.origin + u.pathname : null;
}

// The form action is page content anyway; accept it only as a plain http(s)
// URL. KeePassHttp matches entries on Url (from Firefox), not on SubmitUrl.
senderPolicy.submitUrl = function(value) {
	if(typeof value !== "string" || value.length > senderPolicy.maxStringLength) {
		return null;
	}
	var u = senderPolicy.webUrl(value);
	return u ? u.href : null;
}

senderPolicy.str = function(value) {
	return (typeof value === "string" && value.length <= senderPolicy.maxStringLength) ? value : null;
}

// Plain text from a message: strings and numbers only, others become "".
senderPolicy.text = function(value, max) {
	var t = (typeof value === "string" || typeof value === "number") ? String(value) : "";
	return t.substring(0, max);
}

// Labels for the login chooser popup: strings only, limited size.
senderPolicy.loginLabels = function(value) {
	if(!Array.isArray(value)) {
		return [];
	}
	var out = [];
	for(var i = 0; i < value.length && i < senderPolicy.maxListLength; i++) {
		out.push(senderPolicy.text(value[i], 300));
	}
	return out;
}

// { username: id|null, password: id|null, fields: [id, ...] } or null (= discard).
senderPolicy.definedFields = function(value) {
	if(value === null) {
		return null;
	}
	if(typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	// A field id is a string; jQuery .data() turns a numeric id ("42") into a number.
	var id = function(v) {
		if(typeof v === "number" && isFinite(v)) {
			return v;
		}
		return (typeof v === "string" && v.length <= 1024) ? v : null;
	};
	var fields = [];
	if(Array.isArray(value.fields)) {
		for(var i = 0; i < value.fields.length && i < 100; i++) {
			var f = id(value.fields[i]);
			if(f !== null) {
				fields.push(f);
			}
		}
	}
	return {
		"username": id(value.username),
		"password": id(value.password),
		"fields": fields
	};
}

// Settings for a content script: only the defined fields of its own origin.
senderPolicy.settingsForOrigin = function(settings, origin) {
	var copy = JSON.parse(JSON.stringify(settings || {}));
	var all = copy["defined-credential-fields"] || {};
	copy["defined-credential-fields"] = {};
	if(origin && Object.prototype.hasOwnProperty.call(all, origin)) {
		copy["defined-credential-fields"][origin] = all[origin];
	}
	return copy;
}

// Entries returned to a frame, without passwords: used later for the
// "update existing entry" list in the save popup.
senderPolicy.knownLogins = function(entries) {
	var out = [];
	if(!Array.isArray(entries)) {
		return out;
	}
	for(var i = 0; i < entries.length; i++) {
		var e = entries[i] || {};
		out.push({ "Login": String(e.Login || ""), "Name": String(e.Name || ""), "Uuid": String(e.Uuid || "") });
	}
	return out;
}
