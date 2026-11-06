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

// The old online update check is removed: drop its stored value.
browser.storage.local.remove('latestKeePassHttp');

browser.storage.local.get({'keyRing': {}})
	.then((item) => {
	// in-memory filter only; migrateKeyRing() persists the removal
	keepass.dropWeakKeys(item.keyRing);
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

		request.Login = keepass.encrypt(cryptoHelpers.encode_utf8(username), key, iv);

		request.Password = keepass.encrypt(cryptoHelpers.encode_utf8(password), key, iv);
		request.Url = keepass.encrypt(url, key, iv);
		request.SubmitUrl = keepass.encrypt(url, key, iv);

		if(entryId) {
			request.Uuid = keepass.encrypt(entryId, key, iv);
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
		request.Url = keepass.encrypt(url, key, iv);

		if(submiturl) {
			request.SubmitUrl = keepass.encrypt(submiturl, key, iv);
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
					var rIv = r.Nonce;
					for (var i = 0; i < r.Entries.length; i++) {
						keepass.decryptEntry(r.Entries[i], key, rIv);
					}
					entries = r.Entries;
					keepass.updateLastUsed(keepass.databaseHash);
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
						for (var i = 0; i < r.Entries.length; i++) {
							keepass.decryptEntry(r.Entries[i], key, rIv);
						}
						passwords = r.Entries;
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

keepass.associate = function(callback, tab) {
	if(keepass.isAssociated()) {
		return;
	}

	keepass.getDatabaseHash(tab).then(async () => {
		if(keepass.isDatabaseClosed || !keepass.isKeePassHttpAvailable) {
			return;
		}

		page.tabs[tab.id].errorMessage = null;

		var rawKey = cryptoHelpers.randomBytes(keepass.keyBytes);
		var key = keepass.b64e(rawKey);

		var request = {
			RequestType: "associate",
			Key: key
		};

		await keepass.setVerifier(request, key);

		keepass.sendAsync(request).then(async (result) => {
			if(keepass.checkStatus(result[0], tab)) {
				var r = JSON.parse(result[1]);

				if(r.Version) {
					keepass.currentKeePassHttp = {
						"version": r.Version,
						"versionParsed": parseInt(r.Version.replace(/\./g,""))
					};
				}

				var id = r.Id;
				if(!(await keepass.verifyResponse(r, key))) {
					page.tabs[tab.id].errorMessage = r.integrityFailed ? keepass.integrityErrorMessage : "KeePass association failed, try again.";
				}
				else {
					keepass.setCryptoKey(id, key);
					keepass.associated.value = true;
					keepass.associated.hash = r.Hash || 0;
				}

				browserAction.show(callback, tab);
			}
		});
	});
}

keepass.isConfigured = function() {
	return new Promise((resolve, reject) => {
		if(typeof(keepass.databaseHash) == "undefined") {
			keepass.getDatabaseHash().then((hash) => {
				resolve(hash in keepass.keyRing);
			});
		} else {
			resolve(keepass.databaseHash in keepass.keyRing);
		}
	});
}

keepass.isAssociated = function() {
	return (keepass.associated.value && keepass.associated.hash && keepass.associated.hash == keepass.databaseHash);
}

keepass.sendAsync = function(request) {
	return new Promise((resolve, reject) => {
		var xhr = new XMLHttpRequest();
		xhr.open("POST", keepass.getPluginUrl(), true);
		xhr.setRequestHeader("Content-Type", "application/json");
		xhr.onload = () => {
			var size = (xhr.responseText || "").length;
			page.debug("Response: HTTP {1}, {2} bytes", xhr.status, size);
			resolve([xhr.status, xhr.responseText]);
		};
		xhr.onerror = (err) => {
			reject(err);
		};
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

keepass.migrateKeyRing = () => {
	return new Promise((resolve, reject) => {
		browser.storage.local.get('keyRing').then((item) => {
			var keyring = item.keyRing;
			// change dates to numbers, for compatibilty with chrome
			if (keyring) {
				var num = 0;
				for (var keyHash in keyring) {
					var key = keyring[keyHash];
					['created', 'lastUsed'].forEach((fld) => {
						var v = key[fld];
						if (v instanceof Date && v.valueOf() >= 0) {
							key[fld] = v.valueOf();
							num++;
						} else if (typeof v !== 'number') {
							key[fld] = Date.now().valueOf();
							num++;
						}
					});
				}
				var removed = keepass.dropWeakKeys(keyring);
				if (num > 0 || removed > 0) {
					browser.storage.local.set({ keyRing: keyring });
				}
				keepass.keyRing = keyring;
			}
			resolve();
		});
	});
};

// Keys created before keyGen 2 came from Math.random() and must not be used.
// Removing them forces a new association with a key from the CSPRNG.
keepass.keyGeneration = 2;

keepass.integrityErrorMessage = "KeePassHttp response failed the integrity check (HMAC). KeePassHttp 2.3.0 or newer is required.";

keepass.dropWeakKeys = function(keyring) {
	var removed = 0;
	if (!keyring || typeof keyring !== "object") {
		return removed;
	}
	for (var hash of Object.keys(keyring)) {
		if (!keyring[hash] || keyring[hash].keyGen !== keepass.keyGeneration) {
			delete keyring[hash];
			removed++;
		}
	}
	if (removed > 0) {
		console.log("KeePassHttp-Connector: removed " + removed + " weak key(s); please connect to KeePass again.");
	}
	return removed;
}

keepass.saveKey = function(hash, id, key) {
	if(!(hash in keepass.keyRing)) {
		keepass.keyRing[hash] = {
			"id": id,
			"key": key,
			"icon": "blue",
			"created": new Date().valueOf(),
			"lastUsed": new Date().valueOf()
		}
	}
	else {
		keepass.keyRing[hash].id = id;
		keepass.keyRing[hash].key = key;
	}
	keepass.keyRing[hash].keyGen = keepass.keyGeneration;
	browser.storage.local.set({'keyRing': keepass.keyRing});
}

keepass.updateLastUsed = function(hash) {
	if((hash in keepass.keyRing)) {
		keepass.keyRing[hash].lastUsed = new Date().valueOf();
		browser.storage.local.set({'keyRing': keepass.keyRing});
	}
}

keepass.deleteKey = function(hash) {
	delete keepass.keyRing[hash];
	browser.storage.local.set({'keyRing': keepass.keyRing});
}

keepass.getIconColor = function() {
	return ((keepass.databaseHash in keepass.keyRing) && keepass.keyRing[keepass.databaseHash].icon) ? keepass.keyRing[keepass.databaseHash].icon : "blue";
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

keepass.testAssociation = function (tab, triggerUnlock) {
	return new Promise((resolve, reject) => {
		keepass.getDatabaseHash(tab, triggerUnlock).then(async () => {
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

			keepass.sendAsync(request).then(async (result) => {
				var status = result[0];
				var response = result[1];

				if(keepass.checkStatus(status, tab)) {
					var r = JSON.parse(response);
					var id = verifier[0];
					var key = verifier[1];
	
					if(r.Version) {
						keepass.currentKeePassHttp = {
							"version": r.Version,
							"versionParsed": parseInt(r.Version.replace(/\./g,""))
						};
					}

				keepass.isEncryptionKeyUnrecognized = false;
					var verified = await keepass.verifyResponse(r, key, id);
					if(!verified && r.integrityFailed) {
						// Do not delete the key: a tampered response must not force a new
						// association (associate sends the key in clear).
						page.tabs[tab.id].errorMessage = keepass.integrityErrorMessage;
					}
					else if(!verified) {
						var hash = r.Hash || 0;
						keepass.deleteKey(hash);
						keepass.isEncryptionKeyUnrecognized = true;
						console.log("Encryption key is not recognized!");
						page.tabs[tab.id].errorMessage = "Encryption key is not recognized.";
						keepass.associated.value = false;
						keepass.associated.hash = null;
					}
					else if(!keepass.isAssociated()) {
						console.log("Association was not successful");
						page.tabs[tab.id].errorMessage = "Association was not successful.";
					}
				}

				resolve(keepass.isAssociated());
			});
		});
	});
}

keepass.getDatabaseHash = function (tab, triggerUnlock) {
	return new Promise((resolve, reject) => {
		var request = {
			"RequestType": "test-associate",
			"TriggerUnlock": (triggerUnlock === true) ? "true" : false
		};

		var oldDatabaseHash = keepass.databaseHash;

		keepass.sendAsync(request).then((result) => {
			if(keepass.checkStatus(result[0], tab)) {
				var response = JSON.parse(result[1]);
				keepass.setCurrentKeePassHttpVersion(response.Version);
				keepass.databaseHash = response.Hash || "no-hash";
			} else {
				keepass.databaseHash = "no-hash";
			}

			if(oldDatabaseHash && oldDatabaseHash != keepass.databaseHash) {
				//console.log("clear association (old db hash != new db hash ==> " + oldDatabaseHash + " != " + keepass.databaseHash);
				keepass.associated.value = false;
				keepass.associated.hash = null;
			}

			resolve(keepass.databaseHash);
		}).catch((reason) => {
			page.tabs[tab.id].errorMessage = "Unable to connect to KeePassHttp";
			resolve(null);
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

	request.Verifier = keepass.encrypt(request.Nonce, key, request.Nonce);
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
		value = keepass.decrypt(response.Verifier, key, iv, true);
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
	if(!(keepass.databaseHash in keepass.keyRing)) {
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

keepass.encrypt = function(input, key, iv) {
	return keepass.b64e(
		slowAES.encrypt(
			keepass.to_b(input),
			slowAES.modeOfOperation.CBC,
			keepass.b64d(key),
			keepass.b64d(iv)
		)
	);
}

keepass.decrypt = function(input, key, iv, toStr) {
	var output = slowAES.decrypt(
			keepass.b64d(input),
			slowAES.modeOfOperation.CBC,
			keepass.b64d(key),
			keepass.b64d(iv)
		);

	return toStr ? keepass.to_s(output) : output;
}

keepass.decryptEntry = function (e, key, iv) {
	e.Uuid = keepass.decrypt(e.Uuid, key, iv, true);
	e.Name = UTF8.decode(keepass.decrypt(e.Name, key, iv, true));
	e.Login = UTF8.decode(keepass.decrypt(e.Login, key, iv, true));
	e.Password = UTF8.decode(keepass.decrypt(e.Password, key, iv, true));

	if(e.StringFields) {
		for(var i = 0; i < e.StringFields.length; i++) {
			e.StringFields[i].Key = UTF8.decode(keepass.decrypt(e.StringFields[i].Key, key, iv, true))
			e.StringFields[i].Value = UTF8.decode(keepass.decrypt(e.StringFields[i].Value, key, iv, true))
		}
	}
}
