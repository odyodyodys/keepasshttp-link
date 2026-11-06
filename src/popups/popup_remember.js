var _tab;

function $q(selector) {
	return document.querySelector(selector);
}

function _initialize(tab) {
	_tab = tab;

	// no credentials set or credentials already cleared
	if(!_tab || !_tab.credentials || !_tab.credentials.username) {
		_close();
		return;
	}

	// no existing credentials to update --> disable update-button
	if(_tab.credentials.list.length == 0) {
		$q("#btn-update").disabled = true;
	}

	var url = _tab.credentials.url;
	url = (url.length > 50) ? url.substring(0, 50) + "..." : url;
	$q(".information-url span").textContent = url;
	$q(".information-username span").textContent = _tab.credentials.username;

	$q("#btn-new").addEventListener("click", function() {
		browser.runtime.sendMessage({
			action: 'add_credentials',
			args: [_tab.credentials.username, _tab.credentials.password, _tab.credentials.url]
		}).then(_verifyResult);
	});

	$q("#btn-update").addEventListener("click", function(e) {
		e.preventDefault();

		// only one entry which could be updated
		if(_tab.credentials.list.length == 1) {
			browser.runtime.sendMessage({
				action: 'update_credentials',
				args: [_tab.credentials.list[0].Uuid, _tab.credentials.username, _tab.credentials.password, _tab.credentials.url]
			}).then(_verifyResult);
			return;
		}

		$q(".credentials .username-new strong").textContent = _tab.credentials.username;
		$q(".credentials .username-exists strong").textContent = _tab.credentials.username;
		$q(".credentials .username-new").hidden = !!_tab.credentials.usernameExists;
		$q(".credentials .username-exists").hidden = !_tab.credentials.usernameExists;

		var ul = $q("ul#list");
		ul.textContent = "";
		_tab.credentials.list.forEach(function(entry) {
			var a = document.createElement("a");
			a.href = "#";
			a.textContent = entry.Login + " (" + entry.Name + ")";
			a.addEventListener("click", function(e) {
				e.preventDefault();
				browser.runtime.sendMessage({
					action: 'update_credentials',
					args: [entry.Uuid, _tab.credentials.username, _tab.credentials.password, _tab.credentials.url]
				}).then(_verifyResult);
			});
			if(_tab.credentials.usernameExists && _tab.credentials.username == entry.Login) {
				a.classList.add("match");
			}
			var li = document.createElement("li");
			li.appendChild(a);
			ul.appendChild(li);
		});

		$q(".credentials").hidden = false;
	});

	$q("#btn-dismiss").addEventListener("click", function(e) {
		e.preventDefault();
		_close();
	});
}

function _connected_database(db) {
	var box = $q(".connected-database");
	if(db.count > 1 && db.identifier) {
		$q(".connected-database em").textContent = db.identifier;
		box.hidden = false;
	}
	else {
		box.hidden = true;
	}
}

function _verifyResult(code) {
	if(code == "success") {
		_close();
	}
}

function _close() {
	browser.runtime.sendMessage({
		action: 'remove_credentials_from_tab_information'
	});

	browser.runtime.sendMessage({
		action: 'pop_stack'
	});

	close();
}

browser.runtime.sendMessage({
	action: 'stack_add',
	args: ["save", "popup_remember.html", 10, true, 0]
});

browser.runtime.sendMessage({
	action: 'get_tab_information'
}).then(_initialize);

browser.runtime.sendMessage({
	action: 'get_connected_database'
}).then(_connected_database);
