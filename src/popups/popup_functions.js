// Shared by the toolbar popups: the "Settings" and "Choose own credential
// fields" buttons. Scripts load with "defer", so the DOM is ready here.

function initSettings() {
	var options = document.getElementById("btn-options");
	if(options) {
		options.addEventListener("click", function() {
			browser.tabs.create({
				url: "/options/options.html"
			}).then(close);
		});
	}

	var choose = document.getElementById("btn-choose-credential-fields");
	if(choose) {
		// The active tab of this popup's window (not runtime.getBackgroundPage():
		// it returns null in a private window).
		choose.addEventListener("click", function() {
			browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
				if(tabs.length) {
					browser.tabs.sendMessage(tabs[0].id, {
						action: "choose_credential_fields"
					});
				}
				close();
			});
		});
	}
}

initSettings();
