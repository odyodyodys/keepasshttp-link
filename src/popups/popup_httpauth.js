browser.runtime.getBackgroundPage().then(function(global) {
	browser.tabs.query({ "active": true, "currentWindow": true }).then(function(tabs) {
		var tab = tabs[0];
		var data = global.page.tabs[tab.id].loginList;
		var ul = document.getElementById("login-list");
		if (!/^https:/i.test(String(data.url || ""))) {
			document.getElementById("insecure-warning").hidden = false;
		}
		data.logins.forEach(function(creds) {
			var li = document.createElement("li");
			var a = document.createElement("a");
			a.href = "#";
			a.textContent = creds.Login + " (" + creds.Name + ")";
			a.addEventListener("click", function(e) {
				e.preventDefault();
				if (data.resolve) {
					data.resolve({
						authCredentials: {
							username: creds.Login,
							password: creds.Password
						}
					});
				}
				close();
			});
			li.appendChild(a);
			ul.appendChild(li);
		});
	});
});
