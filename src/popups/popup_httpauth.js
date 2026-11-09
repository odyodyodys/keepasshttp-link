// Toolbar popup of a browser login dialog (HTTP authentication): choose the
// login KeePass should answer it with. The popup gets only labels; the
// background answers the dialog, so the password never reaches the popup.
// Asked by tab id: runtime.getBackgroundPage() returns null in a private window.
browser.tabs.query({ "active": true, "currentWindow": true }).then(function(tabs) {
	if(tabs.length === 0) {
		return;
	}
	var tabId = tabs[0].id;
	browser.runtime.sendMessage({ action: "get_login_list", args: [tabId] }).then(function(info) {
		if(!info || info.kind !== "httpauth") {
			return;
		}
		var ul = document.getElementById("login-list");
		if (!/^https:/i.test(info.url)) {
			document.getElementById("insecure-warning").hidden = false;
		}
		info.labels.forEach(function(label, i) {
			var li = document.createElement("li");
			var a = document.createElement("a");
			a.href = "#";
			a.textContent = label;
			a.addEventListener("click", function(e) {
				e.preventDefault();
				browser.runtime.sendMessage({ action: "httpauth_choose", args: [tabId, i] }).then(function() {}, function() {}).then(function() {
					close();
				});
			});
			li.appendChild(a);
			ul.appendChild(li);
		});
	});
});
