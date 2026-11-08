var keepass = {};

keepass.associated = {"value": false, "hash": null};
keepass.isDatabaseClosed = false;
keepass.isKeePassHttpAvailable = false;
keepass.isEncryptionKeyUnrecognized = false;
keepass.currentKeePassHttp = {"version": 0, "versionParsed": 0};
keepass.keyBytes = 32; // AES-256 key
keepass.ivBytes = 16;  // AES block size
// KeePassHttp runs on this computer only. The host is fixed: no remote hosts.
// It must be "localhost": the plugin (Windows HTTP.sys) rejects other Host values.
keepass.pluginHost = "localhost";
keepass.defaultPort = 19455;
keepass.cacheTimeout = 30 * 1000; // milliseconds
keepass.databaseHash = "no-hash"; //no-hash = keepasshttp is too old and does not return a hash value
keepass.keyId = "chromeipass-cryptokey-name";
keepass.keyBody = "chromeipass-key";
keepass.to_s = cryptoHelpers.convertByteArrayToString;
keepass.to_b = cryptoHelpers.convertStringToByteArray;

keepass.testedWithVersion = "2.3.1.0";
// Settings page: a pairing waits at most this long for the KeePass dialog.
keepass.pairingTimeout = 60 * 1000;
// Settings page: a connection check that gets no answer in this time counts
// as "KeePass is busy" (a modal KeePass dialog blocks the plugin), not as gone.
// Must be longer than a refused connection to localhost takes in Firefox
// on Windows (measured: about 6.4 s), else "KeePass closed" looks like "busy".
keepass.checkTimeout = 10 * 1000;
// The pairing in progress, or null: { xhr, cancelled }.
keepass.pairing = null;
// True if the last database check timed out (KeePass busy).
keepass.lastCheckBusy = false;
// False until KeePassHttp answered or refused once: before that the state
// above is only the start value, not something seen.
keepass.stateKnown = false;

// The old online update check is removed: drop its stored value.
browser.storage.local.remove('latestKeePassHttp');

keepass.keyRing = {};
browser.storage.local.get({'keyRing': {}})
	.then((item) => {
	// in-memory only; loadKeyRing() stores the marks
	keepass.markWeakKeys(item.keyRing);
	keepass.keyRing = item.keyRing;
});

keepass.addCredentials = function(callback, tab, username, password, url) {
	keepass.updateCredentials(callback, tab, null, username, password, url);
}

keepass.updateCredentials = function(callback, tab, entryId, username, password, url) {
	// Logs never contain usernames, passwords, URLs or protocol payloads.
	page.debug("keepass.updateCredentials(tab {1}, {2} entry)", tab.id, entryId ? "existing" : "new");

	// unset error message
	page.tabs[tab.id].errorMessage = null;

	// is browser associated to keepass?
	keepass.testAssociation(tab).then(async (configured) => {
		if(!configured) {
			browserAction.showDefault(null, tab);
			callback("error");
			return;
		}

		// build request
		var request = {
			RequestType: "set-login"
		};
		var verifier = await keepass.setVerifier(request);
		var id = verifier[0];
		var key = verifier[1];
		var iv = request.Nonce;

		request.Login = await keepass.encrypt(username, key, iv);
		request.Password = await keepass.encrypt(password, key, iv);
		request.Url = await keepass.encrypt(url, key, iv);
		request.SubmitUrl = await keepass.encrypt(url, key, iv);

		if(entryId) {
			request.Uuid = await keepass.encrypt(entryId, key, iv);
		}

		// send request
		keepass.sendAsync(request).then(async (result) => {
			var status = result[0];
			var response = result[1];

			// verify response
			var code = "error";
			if(keepass.checkStatus(status, tab)) {
				var r = JSON.parse(response);
				if (await keepass.verifyResponse(r, key, id)) {
					code = "success";
					keepass.updateLastUsed(keepass.databaseHash);
				}
				else {
					code = "error";
				}
			}

			callback(code);
		});
	});
}

keepass.retrieveCredentials = function (callback, tab, url, submiturl, forceCallback, triggerUnlock) {
	page.debug("keepass.retrieveCredentials(tab {1}, forceCallback {2})", tab.id, forceCallback);

	// unset error message
	page.tabs[tab.id].errorMessage = null;

	// is browser associated to keepass?
	keepass.testAssociation(tab, triggerUnlock).then(async (configured) => {
		if(!configured) {
			browserAction.showDefault(null, tab);
			if(forceCallback) {
				callback([]);
			}
			return;
		}

		// build request
		var request = {
			"RequestType": "get-logins",
			"SortSelection": "true",
			"TriggerUnlock": (triggerUnlock === true) ? "true" : "false"
		};
		var verifier = await keepass.setVerifier(request);
		var id = verifier[0];
		var key = verifier[1];
		var iv = request.Nonce;
		request.Url = await keepass.encrypt(url, key, iv);

		if(submiturl) {
			request.SubmitUrl = await keepass.encrypt(submiturl, key, iv);
		}

		// send request
		keepass.sendAsync(request).then(async (result) => {
			var status = result[0];
			var response = result[1];
			var entries = [];

			// verify response
			if(keepass.checkStatus(status, tab)) {
				var r = JSON.parse(response);

				keepass.setCurrentKeePassHttpVersion(r.Version);

				if (await keepass.verifyResponse(r, key, id)) {
					// All entries or none (see decryptEntries).
					entries = (await keepass.decryptEntries(r.Entries, key, r.Nonce)) || [];
					keepass.updateLastUsed(keepass.databaseHash, true);
					if(entries.length == 0) {
						//questionmark-icon is not triggered, so we have to trigger for the normal symbol
						browserAction.showDefault(null, tab);
					}
				}
				else {
					console.log("RetrieveCredentials rejected: response check failed");
				}
			}
			else {
				browserAction.showDefault(null, tab);
			}

			page.debug("keepass.retrieveCredentials() => entries.length = {1}", entries.length);
			callback(entries);
		});
	});
}

keepass.generatePassword = function (callback, tab, forceCallback) {
	// is browser associated to keepass?
	keepass.testAssociation(tab).then(async (configured) => {
		if(!configured) {
			browserAction.showDefault(null, tab);
			if(forceCallback) {
				callback([]);
			}
			return;
		}

		if(keepass.currentKeePassHttp.versionParsed < 1400) {
			callback([]);
			return;
		}

		// build request
		var request = {
			RequestType: "generate-password"
		};
		var verifier = await keepass.setVerifier(request);
		var id = verifier[0];
		var key = verifier[1];

		// send request
		keepass.sendAsync(request).then(async (result) => {
			var status = result[0];
			var response = result[1];
			var passwords = [];

			// verify response
			if(keepass.checkStatus(status, tab)) {
				var r = JSON.parse(response);

				keepass.setCurrentKeePassHttpVersion(r.Version);

				if (await keepass.verifyResponse(r, key, id)) {
					var rIv = r.Nonce;

					if(r.Entries) {
						passwords = (await keepass.decryptEntries(r.Entries, key, rIv)) || [];
						keepass.updateLastUsed(keepass.databaseHash);
					}
					else {
						console.log("No entries returned. Is KeePassHttp up-to-date?");
					}
				}
				else {
					console.log("GeneratePassword rejected");
				}
			}
			else {
				browserAction.showDefault(null, tab);
			}

			callback(passwords);
		});
	});
}

// Pair with the database that is open in KeePass now. KeePass shows its own
// dialog and asks for a name. If expectedHash is given ("Give access again"
// for a known database), the open database must be that one; the entry and
// its description are kept. Only one pairing runs at a time, and it can be
// cancelled (cancelAssociate). The callback (if any) always gets a result:
//   { ok: true, identifier }                      paired
//   { ok: false, reason, error, identifier }      reason: "already", "busy",
//       "unavailable", "locked", "not-active", "refused", "cancelled",
//       "timeout", "error"
keepass.associate = function(callback, tab, expectedHash) {
	var done = function(result) {
		keepass.pairing = null;
		if(typeof callback === "function") {
			callback(result);
		}
	};
	var current = function() {
		var entry = keepass.keyRing[keepass.databaseHash];
		return entry ? entry.id : null;
	};
	var tabInfo = function() {
		return page.tabs[tab.id] || {};
	};

	if(keepass.pairing) {
		if(typeof callback === "function") {
			callback({ ok: false, reason: "busy", error: "A pairing is already waiting for KeePass." });
		}
		return;
	}
	if(keepass.isAssociated()) {
		if(typeof callback === "function") {
			callback({ ok: false, reason: "already", identifier: current() });
		}
		return;
	}

	var pairing = keepass.pairing = { xhr: null, cancelled: false };

	keepass.getDatabaseHash(tab).then(async () => {
		if(pairing.cancelled) {
			done({ ok: false, reason: "cancelled" });
			return;
		}
		if(!keepass.isKeePassHttpAvailable) {
			done({ ok: false, reason: "unavailable", error: "KeePass or the KeePassHttp plugin does not answer." });
			return;
		}
		if(keepass.isDatabaseClosed) {
			done({ ok: false, reason: "locked", error: "The KeePass database is locked or closed." });
			return;
		}
		if(expectedHash && expectedHash !== keepass.databaseHash) {
			done({ ok: false, reason: "not-active", error: "This database is not the active one in KeePass." });
			return;
		}

		tabInfo().errorMessage = null;

		var rawKey = cryptoHelpers.randomBytes(keepass.keyBytes);
		var key = keepass.b64e(rawKey);

		var request = {
			RequestType: "associate",
			Key: key
		};

		await keepass.setVerifier(request, key);

		keepass.sendAsync(request, {
			timeout: keepass.pairingTimeout,
			onXhr: function(xhr) { pairing.xhr = xhr; }
		}).then(async (result) => {
			if(!keepass.checkStatus(result[0], tab)) {
				done({ ok: false, reason: "error", error: tabInfo().errorMessage || ("KeePassHttp answered with status " + result[0] + ".") });
				return;
			}
			var r = JSON.parse(result[1]);

			keepass.setCurrentKeePassHttpVersion(r.Version);

			var id = r.Id;
			if(!(await keepass.verifyResponse(r, key))) {
				var error = r.integrityFailed ? keepass.integrityErrorMessage : "KeePass did not confirm the pairing. The dialog was cancelled, or no name was given.";
				tabInfo().errorMessage = error;
				browserAction.show(null, tab);
				done({ ok: false, reason: "refused", error: error });
				return;
			}

			keepass.setCryptoKey(id, key);
			keepass.associated.value = true;
			keepass.associated.hash = r.Hash || 0;
			browserAction.show(null, tab);
			done({ ok: true, identifier: id });
		}).catch((e) => {
			if(pairing.cancelled) {
				done({ ok: false, reason: "cancelled" });
			} else if(e && e.kphTimeout) {
				done({ ok: false, reason: "timeout", error: "KeePass did not answer within " + (keepass.pairingTimeout / 1000) + " seconds." });
			} else {
				done({ ok: false, reason: "error", error: "Unable to connect to KeePassHttp." });
			}
		});
	});
}

// Stop waiting for the pairing. Firefox cannot close the dialog in KeePass:
// the plugin stays busy until the user closes it there.
keepass.cancelAssociate = function(callback) {
	var pairing = keepass.pairing;
	if(pairing) {
		pairing.cancelled = true;
		if(pairing.xhr) {
			pairing.xhr.abort();
		}
	}
	if(typeof callback === "function") {
		callback(!!pairing);
	}
}

// Connection check for the settings page. Sends a test request (with the
// KeePass unlock prompt if triggerUnlock) and reports the state. Without
// triggerUnlock the request has a time limit: no answer in time means
// KeePass is busy ("busy": true), and the page keeps its last state.
// While a pairing waits for KeePass, nothing is sent (the plugin is blocked).
// cached: answer at once from the last known state, without a request (the
// settings page shows the card with it while the first real check runs).
keepass.checkConnection = function(callback, tab, triggerUnlock, cached) {
	var reply = function(associated) {
		var hash = (keepass.databaseHash && keepass.databaseHash !== "no-hash") ? keepass.databaseHash : null;
		var entry = hash ? keepass.keyRing[hash] : null;
		var version = keepass.currentKeePassHttp.version;
		callback({
			"pluginAvailable": keepass.isKeePassHttpAvailable,
			"databaseClosed": keepass.isDatabaseClosed,
			"busy": keepass.lastCheckBusy,
			"known": keepass.stateKnown,
			"pairingInFlight": !!keepass.pairing,
			"version": (!version || version <= 0) ? null : String(version),
			"testedWith": keepass.testedWithVersion,
			"port": keepass.parsePort(page.settings.port) || keepass.defaultPort,
			"hash": hash,
			"paired": !!entry,
			"associated": associated === true,
			"identifier": entry ? entry.id : null,
			"integrityFailed": (page.tabs[tab.id] && page.tabs[tab.id].errorMessage === keepass.integrityErrorMessage) || false,
			"error": (page.tabs[tab.id] && page.tabs[tab.id].errorMessage) || null
		});
	};
	if(keepass.pairing) {
		reply(false);
		return;
	}
	if(cached === true) {
		reply(keepass.isAssociated());
		return;
	}
	var opts = (triggerUnlock === true) ? null : { timeout: keepass.checkTimeout };
	keepass.testAssociation(tab, triggerUnlock === true, opts).then(reply);
}

keepass.isConfigured = function() {
	return new Promise((resolve, reject) => {
		var usable = function(hash) {
			var entry = keepass.keyRing[hash];
			return !!entry && entry.status !== "lost";
		};
		if(typeof(keepass.databaseHash) == "undefined") {
			keepass.getDatabaseHash().then((hash) => {
				resolve(usable(hash));
			});
		} else {
			resolve(usable(keepass.databaseHash));
		}
	});
}

keepass.isAssociated = function() {
	return (keepass.associated.value && keepass.associated.hash && keepass.associated.hash == keepass.databaseHash);
}

// opts (optional): timeout (ms), onXhr(xhr) to keep the request for abort().
// Rejects with { kphTimeout }, { kphAborted } or { kphNetwork }.
keepass.sendAsync = function(request, opts) {
	opts = opts || {};
	return new Promise((resolve, reject) => {
		var xhr = new XMLHttpRequest();
		xhr.open("POST", keepass.getPluginUrl(), true);
		xhr.setRequestHeader("Content-Type", "application/json");
		if(opts.timeout) {
			xhr.timeout = opts.timeout;
		}
		xhr.onload = () => {
			var size = (xhr.responseText || "").length;
			page.debug("Response: HTTP {1}, {2} bytes", xhr.status, size);
			resolve([xhr.status, xhr.responseText]);
		};
		xhr.onerror = () => {
			reject({ kphNetwork: true });
		};
		xhr.ontimeout = () => {
			reject({ kphTimeout: true });
		};
		xhr.onabort = () => {
			reject({ kphAborted: true });
		};
		if(typeof opts.onXhr === "function") {
			opts.onXhr(xhr);
		}
		try {
			var r = JSON.stringify(request);
			page.debug("Request: {1}", String(request.RequestType));
			xhr.send(r);
		}
		catch (e) {
			console.log("KeePassHttp: " + e);
		}
	});
}

keepass.checkStatus = function (status, tab) {
	var success = (status >= 200 && status <= 299);
	var wasClosed = keepass.isDatabaseClosed;
	var wasAvailable = keepass.isKeePassHttpAvailable;
	keepass.stateKnown = true;
	keepass.isDatabaseClosed = false;
	keepass.isKeePassHttpAvailable = true;

	if(tab && page.tabs[tab.id]) {
		delete page.tabs[tab.id].errorMessage;
	}
	if (!success) {
		keepass.associated.value = false;
		keepass.associated.hash = null;
		if(tab && page.tabs[tab.id]) {
			page.tabs[tab.id].errorMessage = "Unknown error: " + status;
		}
		console.log("Error: "+ status);
		if (status == 503) {
			keepass.isDatabaseClosed = true;
			console.log("KeePass database is not opened");
			if(tab && page.tabs[tab.id]) {
				page.tabs[tab.id].errorMessage = "KeePass database is not opened.";
			}
		}
		else if (status == 0) {
			keepass.isKeePassHttpAvailable = false;
			console.log("Could not connect to keepass");
			if(tab && page.tabs[tab.id]) {
				page.tabs[tab.id].errorMessage = "Is KeePassHttp installed and is KeePass running?";
			}
		}
	}

	// KeePass was just locked (HTTP 503) or is gone: drop the logins that pages
	// still hold, so nothing is filled from old data after the user locked KeePass.
	if((keepass.isDatabaseClosed && !wasClosed) || (!keepass.isKeePassHttpAvailable && wasAvailable)) {
		page.clearAllLogins();
	}

	page.debug("keepass.checkStatus({1}, [tabID]) => {2}", status, success);

	return success;
}

// Key ring: browser.storage.local "keyRing", one entry per database hash:
//   id           key name typed in the KeePass pairing dialog
//   key          AES key (Base64). Removed when the entry is marked lost.
//   keyGen       key generation (see keepass.keyGeneration)
//   status       "ok" or "lost" (KeePass rejected the key, or the key is weak)
//   lostReason   "rejected" | "weak" (only when lost)
//   addedAt      time of the first pairing (ms)
//   lastUsedAt   last successful get-logins or save (ms), missing until then
//   description  optional note from the settings page
//   firstFillNote  true after a pairing, until the first get-logins or "Got it"
// An entry is deleted only by "Remove" on the settings page (removeKey).

// Load the stored ring and mark weak keys (start-up).
keepass.loadKeyRing = function() {
	return browser.storage.local.get({'keyRing': {}}).then((item) => {
		var keyring = item.keyRing || {};
		if(keepass.markWeakKeys(keyring) > 0) {
			browser.storage.local.set({ keyRing: keyring });
		}
		keepass.keyRing = keyring;
	});
};

// Keys created before keyGen 2 came from Math.random() and must not be used.
// Marking them lost forces a new association with a key from the CSPRNG.
keepass.keyGeneration = 2;

keepass.integrityErrorMessage = "KeePassHttp response failed the integrity check (HMAC). KeePassHttp 2.3.0 or newer is required.";

keepass.saveKeyRing = function() {
	return browser.storage.local.set({'keyRing': keepass.keyRing});
}

// Mark one entry lost and drop its key. The entry and its description stay.
keepass.markLostEntry = function(entry, reason) {
	entry.status = "lost";
	entry.lostReason = reason;
	delete entry.key;
	delete entry.firstFillNote;
}

// Marks entries with an old key generation as lost ("weak"). Removes only
// values that are not entries at all. Returns the number of changes.
keepass.markWeakKeys = function(keyring) {
	var changed = 0;
	if (!keyring || typeof keyring !== "object") {
		return changed;
	}
	for (var hash of Object.keys(keyring)) {
		var entry = keyring[hash];
		if (!entry || typeof entry !== "object") {
			delete keyring[hash];
			changed++;
		}
		else if (entry.status !== "lost" && entry.keyGen !== keepass.keyGeneration) {
			keepass.markLostEntry(entry, "weak");
			changed++;
		}
	}
	if (changed > 0) {
		console.log("KeePassHttp-Link: " + changed + " weak key(s) retired; give access again on the settings page.");
	}
	return changed;
}

keepass.saveKey = function(hash, id, key) {
	var entry = keepass.keyRing[hash];
	if(!entry) {
		entry = keepass.keyRing[hash] = { "addedAt": Date.now() };
	}
	entry.id = id;
	entry.key = key;
	entry.keyGen = keepass.keyGeneration;
	entry.status = "ok";
	delete entry.lostReason;
	entry.firstFillNote = true;
	keepass.saveKeyRing();
}

// After a successful get-logins (fill = true) or save for this database.
keepass.updateLastUsed = function(hash, fill) {
	var entry = keepass.keyRing[hash];
	if(entry) {
		entry.lastUsedAt = Date.now();
		if(fill) {
			delete entry.firstFillNote;
		}
		keepass.saveKeyRing();
	}
}

// KeePass did not recognize the key: keep the entry, mark it lost.
keepass.markKeyLost = function(hash, reason) {
	var entry = keepass.keyRing[hash];
	if(entry) {
		keepass.markLostEntry(entry, reason);
		keepass.saveKeyRing();
	}
}

// "Remove" on the settings page: the only path that deletes an entry.
keepass.removeKey = function(hash) {
	delete keepass.keyRing[hash];
	if(keepass.associated.hash === hash) {
		keepass.associated.value = false;
		keepass.associated.hash = null;
	}
	return keepass.saveKeyRing();
}

// Settings page: change the description, or dismiss the one-time note.
keepass.updateKeyEntry = function(hash, change) {
	var entry = keepass.keyRing[hash];
	if(!entry || !change || typeof change !== "object") {
		return Promise.resolve(false);
	}
	if(typeof change.description === "string") {
		var d = change.description.trim().slice(0, 200);
		if(d) {
			entry.description = d;
		} else {
			delete entry.description;
		}
	}
	if(change.dismissFirstFillNote === true) {
		delete entry.firstFillNote;
	}
	return keepass.saveKeyRing().then(() => true);
}

// The key ring without the keys, for the settings page.
keepass.publicKeyRing = function() {
	var out = {};
	for(var hash of Object.keys(keepass.keyRing)) {
		var e = keepass.keyRing[hash];
		out[hash] = {
			id: e.id,
			status: e.status === "lost" ? "lost" : "ok",
			lostReason: e.lostReason || null,
			addedAt: typeof e.addedAt === "number" ? e.addedAt : null,
			lastUsedAt: typeof e.lastUsedAt === "number" ? e.lastUsedAt : null,
			description: e.description || "",
			firstFillNote: e.firstFillNote === true
		};
	}
	return out;
}

// Returns the port as a number if it is a valid user port, else null.
keepass.parsePort = function(value) {
	var text = String(value === undefined || value === null ? "" : value).trim();
	if(!/^[0-9]{1,5}$/.test(text)) {
		return null;
	}
	var port = parseInt(text, 10);
	return (port >= 1025 && port <= 65535) ? port : null;
}

keepass.getPluginUrl = function() {
	var port = keepass.parsePort(page.settings.port) || keepass.defaultPort;
	return "http://" + keepass.pluginHost + ":" + port + "/";
}

keepass.setCurrentKeePassHttpVersion = function(version) {
	if(version) {
		keepass.currentKeePassHttp = {
			"version": version,
			"versionParsed": parseInt(version.replace(/\./g,""))
		};
	}
}

// opts (optional) go to sendAsync, e.g. a time limit for the settings page.
keepass.testAssociation = function (tab, triggerUnlock, opts) {
	var tabInfo = function() {
		return (tab && page.tabs[tab.id]) || {};
	};
	return new Promise((resolve, reject) => {
		keepass.getDatabaseHash(tab, triggerUnlock, opts).then(async () => {
			if(keepass.lastCheckBusy) {
				resolve(keepass.isAssociated());
				return;
			}
			if(keepass.isDatabaseClosed || !keepass.isKeePassHttpAvailable) {
				resolve(false);
				return;
			}

			if(keepass.isAssociated()) {
				resolve(true);
				return;
			}

			var request = {
				"RequestType": "test-associate",
				"TriggerUnlock": (triggerUnlock === true) ? "true" : false
			};
			var verifier = await keepass.setVerifier(request);

			if(!verifier) {
				keepass.associated.value = false;
				keepass.associated.hash = null;
				resolve(false);
				return;
			}

			keepass.sendAsync(request, opts).then(async (result) => {
				var status = result[0];
				var response = result[1];

				if(keepass.checkStatus(status, tab)) {
					var r = JSON.parse(response);
					var id = verifier[0];
					var key = verifier[1];

					keepass.setCurrentKeePassHttpVersion(r.Version);

					keepass.isEncryptionKeyUnrecognized = false;
					var verified = await keepass.verifyResponse(r, key, id);
					if(!verified && r.integrityFailed) {
						// Do not mark the key lost: a tampered response must not force a
						// new association (associate sends the key in clear).
						tabInfo().errorMessage = keepass.integrityErrorMessage;
					}
					else if(!verified) {
						// Keep the entry and its description: the settings page shows
						// "Access lost" and offers "Give access again".
						keepass.markKeyLost(r.Hash || keepass.databaseHash, "rejected");
						keepass.isEncryptionKeyUnrecognized = true;
						console.log("Encryption key is not recognized!");
						tabInfo().errorMessage = "Encryption key is not recognized.";
						keepass.associated.value = false;
						keepass.associated.hash = null;
					}
					else if(!keepass.isAssociated()) {
						console.log("Association was not successful");
						tabInfo().errorMessage = "Association was not successful.";
					}
				}

				resolve(keepass.isAssociated());
			}).catch((e) => {
				// No change of state here: a closed kept-alive connection gives a
				// network error too. The next database check finds a real outage.
				if(e && e.kphTimeout) {
					keepass.lastCheckBusy = true;
				}
				resolve(keepass.isAssociated());
			});
		});
	});
}

// Reads the hash of the active database (unverified test-associate). Always
// resolves. No answer in the time limit (opts.timeout): KeePass is busy, the
// known state stays and keepass.lastCheckBusy is true. Connection refused:
// KeePassHttp is not available.
keepass.getDatabaseHash = function (tab, triggerUnlock, opts) {
	return new Promise((resolve, reject) => {
		var request = {
			"RequestType": "test-associate",
			"TriggerUnlock": (triggerUnlock === true) ? "true" : false
		};

		var oldDatabaseHash = keepass.databaseHash;
		keepass.lastCheckBusy = false;

		var changed = function() {
			if(oldDatabaseHash && oldDatabaseHash != keepass.databaseHash) {
				keepass.associated.value = false;
				keepass.associated.hash = null;
			}
		};

		// The address at sending time. A refused connection takes about 6.4 s
		// in Firefox on Windows: by then the port may have changed (settings
		// page, start-up). An error from an old port says nothing about the
		// current one and is ignored.
		var url = keepass.getPluginUrl();

		keepass.sendAsync(request, opts).then((result) => {
			if(keepass.checkStatus(result[0], tab)) {
				var response = JSON.parse(result[1]);
				keepass.setCurrentKeePassHttpVersion(response.Version);
				keepass.databaseHash = response.Hash || "no-hash";
			} else {
				keepass.databaseHash = "no-hash";
			}
			changed();
			resolve(keepass.databaseHash);
		}).catch((reason) => {
			if(reason && reason.kphTimeout) {
				keepass.lastCheckBusy = true;
				resolve(keepass.databaseHash);
				return;
			}
			if(url !== keepass.getPluginUrl()) {
				resolve(keepass.databaseHash);
				return;
			}
			// Connection refused or aborted: same as no answer (status 0).
			// This drops the logins that pages hold (see checkStatus).
			// checkStatus only writes to a tab entry that exists.
			keepass.checkStatus(0, tab);
			keepass.databaseHash = "no-hash";
			changed();
			resolve(keepass.databaseHash);
		});
	});
}

// Async: sets Id, Nonce, Verifier and Hmac on the request. Resolves to [id, key] or null.
keepass.setVerifier = async function(request, inputKey) {
	var key = inputKey || null;
	var id = null;

	if(!key) {
		var info = keepass.getCryptoKey();
		if (info == null) {
			return null;
		}
		id = info[0];
		key = info[1];
	}

	if(id) {
		request.Id = id;
	}

	var iv = cryptoHelpers.randomBytes(keepass.ivBytes);
	request.Nonce = keepass.b64e(iv);

	request.Verifier = await keepass.encrypt(request.Nonce, key, request.Nonce);
	request.Hmac = await keepass.computeHmac(key, request.Nonce, request.Verifier);

	return [id, key];
}

// HMAC-SHA256(AES key, IV bytes || Verifier ciphertext bytes), Base64.
// Same as KeePassHttp 2.3.x (Protocol.cs ComputeHmac). Uses WebCrypto.
// Note: the plugin's HMAC covers only Nonce and Verifier, not the other fields.
keepass.hmacKey = function(keyB64, usage) {
	return crypto.subtle.importKey("raw", new Uint8Array(keepass.b64d(keyB64)),
		{name: "HMAC", hash: "SHA-256"}, false, [usage]);
}

keepass.hmacData = function(ivB64, cipherB64) {
	return new Uint8Array(keepass.b64d(ivB64).concat(keepass.b64d(cipherB64)));
}

keepass.computeHmac = async function(keyB64, ivB64, cipherB64) {
	var hmacKey = await keepass.hmacKey(keyB64, "sign");
	var sig = await crypto.subtle.sign("HMAC", hmacKey, keepass.hmacData(ivB64, cipherB64));
	return keepass.b64e(Array.from(new Uint8Array(sig)));
}

// True only if the response has a well-formed Nonce, Verifier and Hmac and the
// Hmac is valid. crypto.subtle.verify compares in constant time.
keepass.checkResponseHmac = async function(response, keyB64) {
	try {
		if(typeof response.Nonce !== "string" || typeof response.Verifier !== "string" || typeof response.Hmac !== "string") {
			return false;
		}
		var sig = keepass.b64d(response.Hmac);
		if(sig.length !== 32 || keepass.b64d(response.Nonce).length !== keepass.ivBytes) {
			return false;
		}
		var hmacKey = await keepass.hmacKey(keyB64, "verify");
		return await crypto.subtle.verify("HMAC", hmacKey, new Uint8Array(sig),
			keepass.hmacData(response.Nonce, response.Verifier));
	}
	catch (e) {
		// e.g. invalid Base64
		return false;
	}
}

// Async: checks the Hmac first (required, KeePassHttp 2.3.0+), then the Verifier.
// If the Hmac check fails, sets response.integrityFailed = true.
keepass.verifyResponse = async function(response, key, id) {
	keepass.associated.value = response.Success;
	if (!response.Success) {
		keepass.associated.hash = null;
		return false;
	}

	if (!(await keepass.checkResponseHmac(response, key))) {
		response.integrityFailed = true;
		console.log("KeePassHttp response rejected: Hmac missing or invalid");
		keepass.associated.value = false;
		keepass.associated.hash = null;
		return false;
	}

	keepass.associated.hash = keepass.databaseHash;

	var iv = response.Nonce;
	var value = null;
	try {
		value = await keepass.decrypt(response.Verifier, key, iv);
	}
	catch (e) {
		value = null;
	}

	keepass.associated.value = (value !== null && value == iv);

	if(id) {
		keepass.associated.value = (keepass.associated.value && id == response.Id);
	}

	keepass.associated.hash = (keepass.associated.value) ? keepass.databaseHash : null;

	return keepass.isAssociated();

}

keepass.b64e = function(d) {
	return btoa(keepass.to_s(d));
}

keepass.b64d = function(d) {
	return keepass.to_b(atob(d));
}

keepass.getCryptoKey = function() {
	var entry = keepass.keyRing[keepass.databaseHash];
	if(!entry || entry.status === "lost") {
		return null;
	}

	var id = keepass.keyRing[keepass.databaseHash].id;
	var key = null;

	if(id) {
		key = keepass.keyRing[keepass.databaseHash].key;
	}

	return key ? [id, key] : null;
}

keepass.setCryptoKey = function(id, key) {
	keepass.saveKey(keepass.databaseHash, id, key);
}

// AES-256-CBC with PKCS#7 padding (WebCrypto), as the plugin (.NET Aes,
// Protocol.cs). Text is UTF-8 on both sides. Key, IV and data are Base64.
keepass.aesKey = function(keyB64, usage) {
	return crypto.subtle.importKey("raw", new Uint8Array(keepass.b64d(keyB64)),
		{ name: "AES-CBC" }, false, [usage]);
}

// Resolves to Base64 ciphertext.
keepass.encrypt = async function(text, keyB64, ivB64) {
	var key = await keepass.aesKey(keyB64, "encrypt");
	var data = new TextEncoder().encode(String(text));
	var out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(keepass.b64d(ivB64)) }, key, data);
	return keepass.b64e(Array.from(new Uint8Array(out)));
}

// Resolves to the plain text. Rejects on a wrong key, IV or padding.
keepass.decrypt = async function(dataB64, keyB64, ivB64) {
	var key = await keepass.aesKey(keyB64, "decrypt");
	var out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(keepass.b64d(ivB64)) },
		key, new Uint8Array(keepass.b64d(dataB64)));
	return new TextDecoder("utf-8").decode(out);
}

keepass.decryptEntry = async function (e, key, iv) {
	e.Uuid = await keepass.decrypt(e.Uuid, key, iv);
	e.Name = await keepass.decrypt(e.Name, key, iv);
	e.Login = await keepass.decrypt(e.Login, key, iv);
	e.Password = await keepass.decrypt(e.Password, key, iv);

	if(e.StringFields) {
		for(var i = 0; i < e.StringFields.length; i++) {
			e.StringFields[i].Key = await keepass.decrypt(e.StringFields[i].Key, key, iv);
			e.StringFields[i].Value = await keepass.decrypt(e.StringFields[i].Value, key, iv);
		}
	}
}

// Decrypts all entries, or none: resolves to null if any field fails. The
// plugin's HMAC does not cover the entries, so a changed entry is possible.
keepass.decryptEntries = async function (entries, key, iv) {
	if(!Array.isArray(entries)) {
		return null;
	}
	try {
		for (var i = 0; i < entries.length; i++) {
			await keepass.decryptEntry(entries[i], key, iv);
		}
		return entries;
	}
	catch (e) {
		console.log("KeePassHttp response rejected: an entry could not be decrypted");
		return null;
	}
}
