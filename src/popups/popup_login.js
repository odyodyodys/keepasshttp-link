browser.runtime.getBackgroundPage().then(function(global) {
	browser.tabs.query({"active": true, "currentWindow": true}).then(function(tabs) {
		if (tabs.length === 0)
			return; // For example: only the background devtools or a popup are opened
		var tab = tabs[0];

		var logins = global.page.tabs[tab.id].loginList;
		var ul = document.getElementById("login-list");
		logins.forEach(function(login, i) {
			var li = document.createElement("li");
			var a = document.createElement("a");
			a.href = "#";
			a.id = String(i);
			a.textContent = login;
			a.addEventListener("click", function(e) {
				e.preventDefault();
				// Only the frame that asked for the logins fills them.
				var frameId = global.page.tabs[tab.id].loginFrameId;
				browser.tabs.sendMessage(tab.id, {
					action: 'fill_user_pass_with_specific_login',
					id: String(i)
				}, { frameId: (typeof frameId === "number") ? frameId : 0 });
				close();
			});
			li.appendChild(a);
			ul.appendChild(li);
		});
	});
});
