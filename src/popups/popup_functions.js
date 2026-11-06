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
		choose.addEventListener("click", function() {
			browser.runtime.getBackgroundPage().then(function(global) {
				browser.tabs.sendMessage(global.page.currentTabId, {
					action: "choose_credential_fields"
				});
				close();
			});
		});
	}
}

initSettings();
