var cipevent = {};

cipevent.onMessage = function(request, sender, callback) {
	if(!request || typeof request.action !== "string"
		|| !Object.prototype.hasOwnProperty.call(cipevent.messageHandlers, request.action)) {
		return;
	}

	var kind = senderPolicy.classify(sender, browser.runtime.id, browser.runtime.getURL(""));
	if(!senderPolicy.isAllowed(kind, request.action)) {
		console.log("KeePassHttp-Connector: message '" + request.action + "' refused from " + (kind || "unknown sender"));
		return;
	}

	if(kind === "content") {
		return cipevent.onContentMessage(request, sender, callback);
	}

	// Extension page (popup, options): it acts on the current tab.
	var tabId = (sender.tab && sender.tab.id >= 1) ? sender.tab.id : page.currentTabId;
	var args = Array.isArray(request.args) ? request.args : [];
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

	switch(request.action) {
		case "retrieve_credentials":
			if(!origin) {
				callback([]);
				return true;
			}
			args = [origin, senderPolicy.submitUrl(a[1]), a[2] === true, a[3] === true];
			var reply = callback;
			callback = function(entries) {
				if(page.tabs[tabId] && page.tabs[tabId].knownLogins) {
					page.tabs[tabId].knownLogins[frameId] = senderPolicy.knownLogins(entries);
				}
				reply(entries);
			};
			break;
		case "set_remember_credentials":
			var username = senderPolicy.str(a[0]);
			var password = senderPolicy.str(a[1]);
			var url = senderPolicy.saveUrl(sender.url);
			if(username === null || password === null || !url) {
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
			break;
		case "alert":
			args = [senderPolicy.text(a[0], 1000)];
			break;
		case "generate_password":
			args = [a[0] === true];
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
	if(senderTabId < 1) {
		return;
	}

	if(!page.tabs[senderTabId]) {
		page.createTabEntry(senderTabId);
	}

	// remove information from no longer existing tabs
	page.removePageInformationFromNotExistingTabs();

	browser.tabs.get(senderTabId).then(function(tab) {
		if(!tab) {
			return;
		}

		if (!tab.url) {
			// Issue 6877: tab URL is not set directly after you opened a window
			// using window.open()
			if (!secondTime) {
				window.setTimeout(function() {
					cipevent.invoke(handler, callback, senderTabId, args, true);
				}, 250);
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
	});
}

cipevent.onShowAlert = function(callback, tab, message) {
	if( page.settings.supressAlerts === true ){ console.log(message); }
	else { browser.tabs.executeScript(tab.id, {code: 'alert(' + JSON.stringify(String(message)) + ')'}); }
}

cipevent.onLoadSettings = function(callback, tab) {
	page.initSettings().then((settings) => {
		callback(settings);
	}, (err) => {
		console.log('error loading settings: ' + err);
	});
}

cipevent.onLoadKeyRing = function(callback, tab) {
	browser.storage.local.get({'keyRing': {}}).then(function(item) {
		if(keepass.dropWeakKeys(item.keyRing) > 0) {
			browser.storage.local.set({'keyRing': item.keyRing});
		}
		keepass.keyRing = item.keyRing;
		if(keepass.isAssociated() && !keepass.keyRing[keepass.associated.hash]) {
			keepass.associated = {
				"value": false,
				"hash": null
			};
		}
		callback(item.keyRing);
	}, (err) => {
		console.log('error loading keyRing: ' + err);
	});
}

cipevent.onSaveSettings = function(callback, tab, settings) {
	browser.storage.local.set({'settings': settings}).then(function() {
		cipevent.onLoadSettings();
	});
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
	callback({
		"count": Object.keys(keepass.keyRing).length,
		"identifier": (keepass.keyRing[keepass.associated.hash]) ? keepass.keyRing[keepass.associated.hash].id : null
	});
}

cipevent.onGetKeePassHttpVersions = function(callback, tab) {
	if(keepass.currentKeePassHttp.version == 0) {
		keepass.getDatabaseHash(tab).then(() => {
			callback({"current": keepass.currentKeePassHttp.version, "latest": keepass.latestKeePassHttp.version});
		});
	} else {
		callback({"current": keepass.currentKeePassHttp.version, "latest": keepass.latestKeePassHttp.version});
	}
}

cipevent.onCheckUpdateKeePassHttp = function(callback, tab) {
	keepass.checkForNewKeePassHttpVersion();
	callback({"current": keepass.currentKeePassHttp.version, "latest": keepass.latestKeePassHttp.version});
}

cipevent.onUpdateAvailableKeePassHttp = function(callback, tab) {
	callback(keepass.keePassHttpUpdateAvailable());
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

cipevent.pageClearLogins = function(callback, tab) {
	page.clearLogins(tab.id);
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
	'associate': keepass.associate,
	'check_update_keepasshttp': cipevent.onCheckUpdateKeePassHttp,
	'get_connected_database': cipevent.onGetConnectedDatabase,
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
	'remove_credentials_from_tab_information': cipevent.onRemoveCredentialsFromTabInformation,
	'retrieve_credentials': keepass.retrieveCredentials,
	'show_default_browseraction': browserAction.showDefault,
	'update_credentials': keepass.updateCredentials,
	'save_settings': cipevent.onSaveSettings,
	'save_defined_credential_fields': cipevent.onSaveDefinedFields,
	'set_remember_credentials': cipevent.onSetRememberPopup,
	'stack_add': browserAction.stackAdd,
	'update_available_keepasshttp': cipevent.onUpdateAvailableKeePassHttp,
	'generate_password': keepass.generatePassword,
	'is_firefox': cipevent.isFirefox
};
