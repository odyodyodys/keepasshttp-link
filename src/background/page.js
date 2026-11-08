var page = {};

// special information for every tab
page.tabs = {};

page.currentTabId = -1;
page.blockedTabs = {};

page.initSettings = function() {
	return new Promise((resolve, reject) => {
		browser.storage.local.get({'settings': {}}).then((item) => {
			page.settings = item.settings;
			if(!("autoCompleteUsernames" in page.settings) || page.settings.autoCompleteUsernames === 1) {
				page.settings.autoCompleteUsernames = true;
			}
			// HTTP auth auto-send is off by default. Older versions had it on by
			// default, so turn it off once for existing settings (marker
			// httpAuthDefaultOff). The user can turn it on again in the options.
			if(!("autoFillAndSend" in page.settings) || page.settings.httpAuthDefaultOff !== true) {
				page.settings.autoFillAndSend = false;
				page.settings.httpAuthDefaultOff = true;
			}
			if(!("usePasswordGenerator" in page.settings) || page.settings.usePasswordGenerator === 1) {
				page.settings.usePasswordGenerator = true;
			}
			if(!("autoFillSingleEntry" in page.settings)) {
				page.settings.autoFillSingleEntry = false;
			}
			if(!("autoRetrieveCredentials" in page.settings) || page.settings.autoRetrieveCredentials === 1) {
				page.settings.autoRetrieveCredentials = true;
			}
			// The host is fixed to localhost (see keepass.pluginHost). Remove the old setting.
			delete page.settings.hostname;
			// The online update check is removed. Remove its old setting.
			delete page.settings.checkUpdateKeePassHttp;
			if(!("port" in page.settings) || keepass.parsePort(page.settings.port) === null) {
				page.settings.port = String(keepass.defaultPort);
			}
			// Messages for a failed shortcut fill are shown by default (in-page
			// notification). Older versions hid them by default, so turn them on
			// once for existing settings (marker alertsDefaultOn). The user can
			// turn them off again in the options.
			if(!("supressAlerts" in page.settings) || page.settings.alertsDefaultOn !== true) {
				page.settings.supressAlerts = false;
				page.settings.alertsDefaultOn = true;
			}
			if(!("respectMaxLength" in page.settings)) {
				page.settings.respectMaxLength = false;
			}
			// Save offer timers (milliseconds, as strings): see browserAction.setRememberPopup.
			if(!("blinkTimeout" in page.settings)) {
				page.settings.blinkTimeout = "7500";
			}
			if(!("blinkMinTimeout" in page.settings)) {
				page.settings.blinkMinTimeout = "-1";
			}
			if(!("allowedRedirect" in page.settings)) {
				page.settings.allowedRedirect = "1";
			}
			browser.storage.local.set({'settings': page.settings});
			resolve(page.settings);
		});
	});
}

page.initOpenedTabs = function () {
	return new Promise((resolve, reject) => {
		browser.tabs.query({}).then(function (tabs) {
			for (var i = 0; i < tabs.length; i++) {
				page.createTabEntry(tabs[i].id);
			}

			// set initial tab-ID
			browser.tabs.query({ "active": true, "currentWindow": true }).then(function (tabs) {
				if (tabs.length === 0) {
					resolve();
					return; // For example: only the background devtools or a popup are opened
				}
				page.currentTabId = tabs[0].id;
				browserAction.show(null, tabs[0]);
				resolve();
			});
		});
	});
}

page.isValidProtocol = function(url) {
	var protocol = url.substring(0, url.indexOf(":"));
	protocol = protocol.toLowerCase();
	return !(url.indexOf(".") == -1 || (protocol != "http" && protocol != "https" && protocol != "ftp" && protocol != "sftp"));
}

page.switchTab = function(callback, tab) {
	browserAction.showDefault(null, tab);

	browser.tabs.sendMessage(tab.id, {action: "activated_tab"});
}

page.clearCredentials = function(tabId, complete) {
	if(!page.tabs[tabId]) {
		return;
	}

	page.tabs[tabId].credentials = {};
	delete page.tabs[tabId].credentials;

	if(complete) {
		page.clearLogins(tabId);
		page.tabs[tabId].knownLogins = {};
		page.tabs[tabId].secrets = {};

		browser.tabs.sendMessage(tabId, {
			action: "clear_credentials"
		});
	}
}

page.clearLogins = function(tabId) {
	page.tabs[tabId].loginList = [];
	delete page.tabs[tabId].loginFrameId;
}

// Drop every login the extension holds for pages: the background lists and
// the content-script caches (with passwords) in all tabs and frames.
page.clearAllLogins = function() {
	for(var id in page.tabs) {
		page.clearLogins(id);
		page.tabs[id].knownLogins = {};
		page.tabs[id].secrets = {};
	}
	browser.tabs.query({}).then(function(tabs) {
		for(var i = 0; i < tabs.length; i++) {
			browser.tabs.sendMessage(tabs[i].id, { action: "clear_credentials", reason: "locked" }).catch(function() {});
		}
	});
}

// The tab moved to another origin (scheme + host + port): the login lists of
// the old site must not be shown or used. The "save this login?" data stays,
// it is needed after the redirect that follows a login.
page.onTabUrlChanged = function(tabId, url) {
	var t = page.tabs[tabId];
	if(!t) {
		return;
	}
	var origin = senderPolicy.frameOrigin(url);
	if(t.origin !== origin) {
		page.clearLogins(tabId);
		t.knownLogins = {};
		t.secrets = {};
		t.origin = origin;
	}
}

page.createTabEntry = function(tabId) {
	//console.log("page.createTabEntry("+tabId+")");
	page.tabs[tabId] = {
		"stack": [],
		"errorMessage": null,
		"loginList": {},
		// frameId -> [{Login, Name, Uuid}] last returned to that frame (no passwords)
		"knownLogins": {},
		// frameId -> {origin, byRef: {ref: {Login, Password, StringFields}}} (item 16)
		"secrets": {}
	};
}

page.removePageInformationFromNotExistingTabs = function() {
	var rand = Math.floor(Math.random()*1001);
	if(rand == 28) {
		browser.tabs.query({}).then(function(tabs) {
			var $tabIds = {};
			var $infoIds = Object.keys(page.tabs);

			for(var i = 0; i < tabs.length; i++) {
				$tabIds[tabs[i].id] = true;
			}

			for(var i = 0; i < $infoIds.length; i++) {
				if(!($infoIds[i] in $tabIds)) {
					delete page.tabs[$infoIds[i]];
				}
			}
		});
	}
};

page.debugConsole = function() {
	if(arguments.length > 1) {
		console.log(page.sprintf(arguments[0], arguments));
	}
	else {
		console.log(arguments[0]);
	}
};

page.sprintf = function(input, args) {
	return input.replace(/{(\d+)}/g, function(match, number) {
		return typeof args[number] != 'undefined'
			? (typeof args[number] == 'object' ? JSON.stringify(args[number]) : args[number])
			: match;
	});
}

page.debugDummy = function() {};

page.debug = page.debugDummy;

page.setDebug = function(bool) {
	if(bool) {
		page.debug = page.debugConsole;
		return "Debug mode enabled";
	}
	else {
		page.debug = page.debugDummy;
		return "Debug mode disabled";
	}
};
