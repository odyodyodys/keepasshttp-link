var cipevent = {};

cipevent.onMessage = function(request, sender, callback) {
	if(!request || typeof request.action !== "string"
		|| !Object.prototype.hasOwnProperty.call(cipevent.messageHandlers, request.action)) {
		return;
	}

	var kind = senderPolicy.classify(sender, browser.runtime.id, browser.runtime.getURL(""));
	if(!senderPolicy.isAllowed(kind, request.action)) {
		console.log("KeePassHttp-Link: message '" + request.action + "' refused from " + (kind || "unknown sender"));
		return;
	}

	if(kind === "content") {
		return cipevent.onContentMessage(request, sender, callback);
	}

	// Extension page (popup, options): it acts on the current tab.
	var tabId = (sender.tab && sender.tab.id >= 1) ? sender.tab.id : page.currentTabId;
	var args = Array.isArray(request.args) ? request.args : [];
	// Toolbar popups name the tab they are about (the active tab of their own
	// window): the background's current tab can be out of date.
	if(cipevent.tabArgActions && cipevent.tabArgActions[request.action] === true && typeof args[0] === "number" && args[0] >= 1) {
		tabId = args[0];
	}
	cipevent.invoke(cipevent.messageHandlers[request.action], callback, tabId, args);

	// onMessage closes channel for callback automatically
	// if this method does not return true
	if(callback) {
		return true;
	}
}

// Messages from content scripts. URLs come from Firefox (sender), not from the
// message; other values are checked for type and size.
cipevent.onContentMessage = function(request, sender, callback) {
	var tabId = sender.tab.id;
	var frameId = sender.frameId;
	var origin = senderPolicy.frameOrigin(sender.url);
	var a = Array.isArray(request.args) ? request.args : [];
	var handler = cipevent.messageHandlers[request.action];
	var args = [];

	if(!page.tabs[tabId]) {
		page.createTabEntry(tabId);
	}
	var tabInfo = page.tabs[tabId];
	if(!tabInfo.knownLogins) {
		tabInfo.knownLogins = {};
	}
	if(!tabInfo.secrets) {
		tabInfo.secrets = {};
	}
	if(frameId === 0 && tabInfo.origin === undefined) {
		tabInfo.origin = origin;
	}

	if(senderPolicy.topOriginOnlyActions[request.action] && senderPolicy.isCrossOriginFrame(sender)) {
		console.log("KeePassHttp-Link: '" + request.action + "' refused for a cross-origin iframe");
		if(request.action === "retrieve_credentials") {
			callback([]);
			return true;
		}
		return;
	}

	switch(request.action) {
		case "retrieve_credentials":
			if(!origin) {
				callback([]);
				return true;
			}
			// Always answer (forceCallback), also when KeePass is locked or gone:
			// else the page waits for an answer that never comes.
			args = [origin, senderPolicy.submitUrl(a[1]), true, a[3] === true];
			var reply = callback;
			callback = function(entries) {
				var t = page.tabs[tabId];
				if(!t) {
					reply([]);
					return;
				}
				if(t.knownLogins) {
					t.knownLogins[frameId] = senderPolicy.knownLogins(entries);
				}
				// The page gets no passwords; they stay here until a fill.
				reply(senderPolicy.splitSecrets(t, frameId, origin, entries));
			};
			break;
		case "set_remember_credentials":
			var username = senderPolicy.str(a[0]);
			var password = senderPolicy.str(a[1]);
			var url = senderPolicy.saveUrl(sender.url);
			if(username === null || password === null || !url) {
				return;
			}
			// Same login and password as an entry KeePass gave this frame: nothing to save.
			if(senderPolicy.isKnownSecret(tabInfo, frameId, username, password)) {
				return;
			}
			var list = tabInfo.knownLogins[frameId] || [];
			var usernameExists = list.some(function(l) { return l.Login === username; });
			args = [username, password, url, usernameExists, list];
			break;
		case "popup_login":
			tabInfo.loginFrameId = frameId;
			args = [senderPolicy.loginLabels(a[0])];
			break;
		case "page_clear_logins":
			delete tabInfo.knownLogins[frameId];
			delete tabInfo.secrets[frameId];
			args = [frameId];
			break;
		case "get_secret":
			callback(senderPolicy.secretFor(tabInfo, frameId, origin, a[0]));
			return true;
		// Two-step sign-in: the user picked a login on the username step. Keep only
		// its name (no password), for this tab and site, for a short time. Only a
		// login KeePass gave this frame is accepted.
		case "remember_pick":
			var picked = senderPolicy.str(a[0]);
			var known = tabInfo.knownLogins[frameId] || [];
			if(origin && picked && known.some(function(l) { return l.Login === picked; })) {
				tabInfo.pick = { origin: origin, login: picked, at: Date.now() };
			}
			return;
		// Password step: the pick, once, only for the same site and in time.
		case "take_pick":
			var pick = tabInfo.pick;
			delete tabInfo.pick;
			callback((pick && origin && pick.origin === origin && Date.now() - pick.at <= cipevent.PICK_TTL_MS) ? { login: pick.login } : null);
			return true;
		case "alert":
			args = [senderPolicy.text(a[0], 1000)];
			break;
		case "generate_password":
			args = [a[0] === true];
			break;
		case "open_settings":
			args = [a[0] === "generator" ? "generator" : "databases"];
			break;
		case "load_settings":
			var replySettings = callback;
			callback = function(settings) {
				replySettings(senderPolicy.settingsForOrigin(settings, origin));
			};
			break;
		case "save_defined_credential_fields":
			var fields = senderPolicy.definedFields(a[0]);
			if(!origin || fields === undefined) {
				return;
			}
			args = [origin, fields];
			break;
	}

	cipevent.invoke(handler, callback, tabId, args);
	return true;
}

/**
 * Get interesting information about the given tab.
 * Function adapted from AdBlock-Plus.
 *
 * @param {function} handler to call after invoke
 * @param {function} callback to call after handler or null
 * @param {integer} senderTabId
 * @param {array} args
 * @param {bool} secondTime
 * @returns null (asynchronous)
 */
cipevent.invoke = function(handler, callback, senderTabId, args, secondTime) {
	// No usable tab: answer with nothing, never leave the sender waiting (a
	// toolbar popup would wait for ever, e.g. with an out-of-date current tab).
	var noAnswer = function() {
		if(typeof callback === "function") {
			callback(undefined);
		}
	};
	if(senderTabId < 1) {
		noAnswer();
		return;
	}

	if(!page.tabs[senderTabId]) {
		page.createTabEntry(senderTabId);
	}

	// remove information from no longer existing tabs
	page.removePageInformationFromNotExistingTabs();

	browser.tabs.get(senderTabId).then(function(tab) {
		if(!tab) {
			noAnswer();
			return;
		}

		if (!tab.url) {
			// Issue 6877: tab URL is not set directly after you opened a window
			// using window.open()
			if (!secondTime) {
				window.setTimeout(function() {
					cipevent.invoke(handler, callback, senderTabId, args, true);
				}, 250);
			} else {
				noAnswer();
			}
			return;
		}

		if(!page.tabs[tab.id]) {
			page.createTabEntry(tab.id);
		}

		args = args || [];

		args.unshift(tab);
		args.unshift(callback);

		if(handler) {
			handler.apply(this, args);
		}
		else {
			console.log("undefined handler for tab " + tab.id);
		}
	}, noAnswer); // the tab no longer exists
}

// The content script shows its own notification (cip.notify). This action is
// kept for old content scripts and only logs.
cipevent.onShowAlert = function(callback, tab, message) {
	console.log("KeePassHttp-Link: " + message);
}

// Settings page: test the connection, with the KeePass unlock prompt if asked,
// or (cached) only report the last known state.
cipevent.onCheckConnection = function(callback, tab, triggerUnlock, cached) {
	keepass.checkConnection(callback, tab, triggerUnlock === true, cached === true);
}

cipevent.onLoadSettings = function(callback, tab) {
	page.initSettings().then((settings) => {
		callback(settings);
	}, (err) => {
		console.log('error loading settings: ' + err);
	});
}

// Settings page: the key ring without the keys.
cipevent.onLoadKeyRing = function(callback, tab) {
	keepass.loadKeyRing().then(function() {
		// The entry was removed, or marked lost (a weak key): the association
		// in memory must not be used any more.
		var entry = keepass.keyRing[keepass.associated.hash];
		if(keepass.isAssociated() && (!entry || entry.status === "lost")) {
			keepass.associated = {
				"value": false,
				"hash": null
			};
		}
		browserAction.refreshAll();
		callback(keepass.publicKeyRing());
	}, (err) => {
		console.log('error loading keyRing: ' + err);
	});
}

// Settings page: "Give Firefox access" / "Give access again" (hash of the
// known database, or nothing).
cipevent.onAssociate = function(callback, tab, expectedHash) {
	keepass.associate(callback, tab, typeof expectedHash === "string" ? expectedHash : null);
}

// Toolbar popup: the current tab's site and how many logins KeePass gave
// its top frame. No login data, only a count.
cipevent.onGetPageSummary = function(callback, tab) {
	var supported = false;
	var site = null;
	try {
		var u = new URL(tab.url);
		supported = (u.protocol === "https:" || u.protocol === "http:");
		site = supported ? u.hostname : null;
	} catch(e) { /* no URL: not supported */ }
	var t = page.tabs[tab.id];
	// asked: a frame of this tab found a sign-in form and asked KeePass.
	// logins: what KeePass returned, all frames together.
	var asked = false;
	var logins = 0;
	if(t && t.knownLogins) {
		Object.keys(t.knownLogins).forEach(function(frameId) {
			if(Array.isArray(t.knownLogins[frameId])) {
				asked = true;
				logins += t.knownLogins[frameId].length;
			}
		});
	}
	// choose: the login list (popup_login.html) has entries for this tab.
	var choose = (t && Array.isArray(t.loginList)) ? t.loginList.length : 0;
	callback({ supported: supported, site: site, asked: asked, logins: logins, choose: choose });
}

// Content script: the generator's "Settings" link. Opens the settings page on
// one of a fixed list of tabs.
cipevent.onOpenSettings = function(callback, tab, section) {
	var allowed = { "generator": true, "databases": true };
	var hash = allowed[section] ? "#" + section : "";
	browser.tabs.create({ url: browser.runtime.getURL("options/options.html") + hash });
}

// Toolbar popups: the login list of a tab (labels only, never passwords).
// The popups cannot read the background page directly: in a private window
// runtime.getBackgroundPage() returns null.
cipevent.onGetLoginList = function(callback, tab) {
	var t = page.tabs[tab.id] || {};
	var list = t.loginList;
	if(Array.isArray(list)) {
		callback({ kind: "logins", labels: list.map(String), frameId: (typeof t.loginFrameId === "number") ? t.loginFrameId : 0 });
	}
	else if(list && Array.isArray(list.logins)) {
		// Browser login dialog (HTTP authentication), see httpauth.js.
		callback({ kind: "httpauth", url: String(list.url || ""), labels: list.logins.map(function(c) {
			return String(c.Login) + " (" + String(c.Name) + ")";
		}) });
	}
	else {
		callback({ kind: "none", labels: [] });
	}
}

// Toolbar popup of a browser login dialog: answer the dialog with the chosen
// login. The password stays in the background.
cipevent.onHttpAuthChoose = function(callback, tab, tabId, index) {
	var t = page.tabs[tab.id];
	var data = t && t.loginList;
	var c = (data && Array.isArray(data.logins) && typeof index === "number") ? data.logins[index] : null;
	if(c && typeof data.resolve === "function") {
		var resolve = data.resolve;
		data.resolve = null;
		resolve({ authCredentials: { username: c.Login, password: c.Password } });
		callback(true);
		return;
	}
	callback(false);
}

cipevent.onCancelAssociate = function(callback, tab) {
	keepass.cancelAssociate(callback);
}

// Settings page: "Remove" (the only way an entry is deleted).
cipevent.onRemoveKey = function(callback, tab, hash) {
	if(typeof hash !== "string" || !(hash in keepass.keyRing)) {
		callback(false);
		return;
	}
	keepass.removeKey(hash).then(function() {
		browserAction.refreshAll();
		callback(true);
	});
}

// Settings page: description, or "Got it" on the one-time note.
cipevent.onUpdateKeyEntry = function(callback, tab, hash, change) {
	if(typeof hash !== "string") {
		callback(false);
		return;
	}
	keepass.updateKeyEntry(hash, change).then(callback);
}

// Content script: save or discard ("fields" = null) the user-chosen
// credential fields of its own origin only.
cipevent.onSaveDefinedFields = function(callback, tab, origin, fields) {
	browser.storage.local.get({'settings': {}}).then(function(item) {
		var settings = item.settings || {};
		if(!settings["defined-credential-fields"] || typeof settings["defined-credential-fields"] !== "object") {
			settings["defined-credential-fields"] = {};
		}
		if(fields === null) {
			delete settings["defined-credential-fields"][origin];
		}
		else {
			settings["defined-credential-fields"][origin] = fields;
		}
		return browser.storage.local.set({'settings': settings});
	}).then(function() {
		return page.initSettings();
	}).then(function() {
		if(callback) {
			callback(true);
		}
	});
}

cipevent.onGetStatus = function(callback, tab) {
	keepass.testAssociation(tab).then((configured) => {
		var keyId = null;
		if (configured) {
			keyId = keepass.keyRing[keepass.databaseHash].id;
		}

		browserAction.showDefault(null, tab);

		callback({
			identifier: keyId,
			configured: configured,
			databaseClosed: keepass.isDatabaseClosed,
			keePassHttpAvailable: keepass.isKeePassHttpAvailable,
			encryptionKeyUnrecognized: keepass.isEncryptionKeyUnrecognized,
			associated: keepass.isAssociated(),
			error: page.tabs[tab.id].errorMessage
		});
	});
}

cipevent.onPopStack = function(callback, tab) {
	browserAction.stackPop(tab.id);
	browserAction.show(null, tab);
}

cipevent.onGetTabInformation = function(callback, tab) {
	var id = tab.id || page.currentTabId;

	callback(page.tabs[id]);
}

cipevent.onGetConnectedDatabase = function(callback, tab) {
	var entry = keepass.keyRing[keepass.associated.hash];
	callback({
		"count": Object.keys(keepass.keyRing).length,
		"identifier": entry ? entry.id : null
	});
}

cipevent.onGetKeePassHttpVersions = function(callback, tab) {
	if(keepass.currentKeePassHttp.version == 0) {
		keepass.getDatabaseHash(tab).then(() => {
			callback({"current": keepass.currentKeePassHttp.version});
		});
	} else {
		callback({"current": keepass.currentKeePassHttp.version});
	}
}

cipevent.onRemoveCredentialsFromTabInformation = function(callback, tab) {
	var id = tab.id || page.currentTabId;

	page.clearCredentials(id);
}

cipevent.onSetRememberPopup = function(callback, tab, username, password, url, usernameExists, credentialsList) {
	browserAction.setRememberPopup(tab.id, username, password, url, usernameExists, credentialsList);
}

cipevent.onLoginPopup = function(callback, tab, logins) {
	var stackData = {
		level: 1,
		iconType: "questionmark",
		popup: "popup_login.html"
	}
	browserAction.stackUnshift(stackData, tab.id);

	page.tabs[tab.id].loginList = logins;

	browserAction.show(null, tab);
}

cipevent.onHTTPAuthPopup = function(callback, tab, data) {
	var stackData = {
		level: 1,
		iconType: "questionmark",
		popup: "popup_httpauth.html"
	}
	browserAction.stackUnshift(stackData, tab.id);

	page.tabs[tab.id].loginList = data;

	browserAction.show(null, tab);
}

cipevent.onMultipleFieldsPopup = function(callback, tab) {
	var stackData = {
		level: 1,
		iconType: "normal",
		popup: "popup_multiple-fields.html"
	}
	browserAction.stackUnshift(stackData, tab.id);

	browserAction.show(null, tab);
}

// A frame starts a new scan: its logins are gone. The toolbar login list is
// cleared only if that frame filled it (another frame, e.g. a hidden iframe,
// must not empty the list of the frame with the sign-in form).
cipevent.pageClearLogins = function(callback, tab, frameId) {
	var t = page.tabs[tab.id];
	if(t && (typeof frameId !== "number" || t.loginFrameId === undefined || t.loginFrameId === frameId)) {
		page.clearLogins(tab.id);
	}
	callback();
}

cipevent.isFirefox = function(callback) {
	callback(utils.isFirefox);
}

cipevent.initHttpAuth = function(callback) {
	httpAuth.init();
	callback();
}

// all methods named in this object have to be declared BEFORE this!
cipevent.messageHandlers = {
	'add_credentials': keepass.addCredentials,
	'alert': cipevent.onShowAlert,
	'associate': cipevent.onAssociate,
	'cancel_associate': cipevent.onCancelAssociate,
	'get_page_summary': cipevent.onGetPageSummary,
	'get_login_list': cipevent.onGetLoginList,
	'httpauth_choose': cipevent.onHttpAuthChoose,
	'check_connection': cipevent.onCheckConnection,
	'get_connected_database': cipevent.onGetConnectedDatabase,
	'open_settings': cipevent.onOpenSettings,
	'get_keepasshttp_versions': cipevent.onGetKeePassHttpVersions,
	'get_status': cipevent.onGetStatus,
	'get_tab_information': cipevent.onGetTabInformation,
	'init_http_auth': cipevent.initHttpAuth,
	'load_keyring': cipevent.onLoadKeyRing,
	'load_settings': cipevent.onLoadSettings,
	'page_clear_logins': cipevent.pageClearLogins,
	'pop_stack': cipevent.onPopStack,
	'popup_login': cipevent.onLoginPopup,
	'popup_multiple-fields': cipevent.onMultipleFieldsPopup,
	'remove_key': cipevent.onRemoveKey,
	'update_key_entry': cipevent.onUpdateKeyEntry,
	'remove_credentials_from_tab_information': cipevent.onRemoveCredentialsFromTabInformation,
	'retrieve_credentials': keepass.retrieveCredentials,
	'show_default_browseraction': browserAction.showDefault,
	'update_credentials': keepass.updateCredentials,
	'save_defined_credential_fields': cipevent.onSaveDefinedFields,
	// Content scripts only (handled in onContentMessage); extension pages get null.
	'get_secret': function(callback) { if(callback) { callback(null); } },
	'remember_pick': function() {},
	'take_pick': function(callback) { if(callback) { callback(null); } },
	'set_remember_credentials': cipevent.onSetRememberPopup,
	'stack_add': browserAction.stackAdd,
	'generate_password': keepass.generatePassword,
	'is_firefox': cipevent.isFirefox
};

// How long a login picked on the username step of a two-step sign-in is kept
// for the password step (see remember_pick / take_pick).
cipevent.PICK_TTL_MS = 5 * 60 * 1000;

// Messages whose first argument is the tab they are about (see onMessage).
cipevent.tabArgActions = {
	'get_page_summary': true,
	'get_login_list': true,
	'httpauth_choose': true
};
