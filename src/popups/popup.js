function status_response(r) {
	$('#initial-state').hide();
	$('#error-encountered').hide();
	$('#need-reconfigure').hide();
	$('#not-configured').hide();
	$('#configured-and-associated').hide();
	$('#configured-not-associated').hide();


	// Error text can come from KeePassHttp: always insert it as text, never as HTML.
	if(!r.keePassHttpAvailable || r.databaseClosed) {
		$('#error-message').text(r.error || "");
		$('#error-encountered').show();
	}
	else if(!r.configured) {
		$('#not-configured').show();
	}
	else if(r.encryptionKeyUnrecognized) {
		$('#need-reconfigure').show();
		$('#need-reconfigure-message').text(r.error || "");
	}
	else if(!r.associated) {
		$('#need-reconfigure').show();
		$('#need-reconfigure-message').text(r.error || "");
	}
	else if(typeof(r.error) != "undefined") {
		$('#error-encountered').show();
		$('#error-message').text(r.error || "");
	}
	else {
		$('#configured-and-associated').show();
		$('#associated-identifier').text(r.identifier || "");
	}
}

$(function() {
	$("#connect-button").click(function() {
		browser.runtime.sendMessage({
			action: "associate"
		});
		close();
	});

	$("#reconnect-button").click(function() {
		browser.runtime.sendMessage({
			action: "associate"
		});
		close();
	});

	$("#reload-status-button").click(function() {
		browser.runtime.sendMessage({
			action: "get_status"
		}).then(status_response);
	});

	$("#redetect-fields-button").click(function() {
		browser.tabs.query({"active": true, "currentWindow": true}).then(function(tabs) {
			if (tabs.length === 0)
				return; // For example: only the background devtools or a popup are opened
			var tab = tabs[0];

			browser.tabs.sendMessage(tab.id, {
				action: "redetect_fields"
			});
		});
	});

	browser.runtime.sendMessage({
		action: "get_status"
	}).then(status_response);
});
