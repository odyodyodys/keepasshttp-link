var POPUP_STATES = ["initial-state", "error-encountered", "need-reconfigure", "not-configured",
	"configured-and-associated", "configured-not-associated"];

function showState(id) {
	POPUP_STATES.forEach(function(s) {
		document.getElementById(s).hidden = (s !== id);
	});
}

// Error text can come from KeePassHttp: always insert it as text, never as HTML.
function status_response(r) {
	if(!r.keePassHttpAvailable || r.databaseClosed) {
		document.getElementById("error-message").textContent = r.error || "";
		showState("error-encountered");
	}
	else if(!r.configured) {
		showState("not-configured");
	}
	else if(r.encryptionKeyUnrecognized || !r.associated) {
		document.getElementById("need-reconfigure-message").textContent = r.error || "";
		showState("need-reconfigure");
	}
	else if(typeof(r.error) != "undefined") {
		document.getElementById("error-message").textContent = r.error || "";
		showState("error-encountered");
	}
	else {
		document.getElementById("associated-identifier").textContent = r.identifier || "";
		showState("configured-and-associated");
	}
}

function associate() {
	browser.runtime.sendMessage({
		action: "associate"
	});
	close();
}

document.getElementById("connect-button").addEventListener("click", associate);
document.getElementById("reconnect-button").addEventListener("click", associate);

document.getElementById("reload-status-button").addEventListener("click", function() {
	browser.runtime.sendMessage({
		action: "get_status"
	}).then(status_response);
});

document.getElementById("redetect-fields-button").addEventListener("click", function() {
	browser.tabs.query({"active": true, "currentWindow": true}).then(function(tabs) {
		if (tabs.length === 0)
			return; // For example: only the background devtools or a popup are opened
		browser.tabs.sendMessage(tabs[0].id, {
			action: "redetect_fields"
		});
	});
});

browser.runtime.sendMessage({
	action: "get_status"
}).then(status_response);
