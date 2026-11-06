if(jQuery) {
	var $ = jQuery.noConflict(true);
}

$(function() {
	browser.runtime.sendMessage({ action: 'load_settings' }).then((settings) => {
		options.settings = settings;
		browser.runtime.sendMessage({ action: 'load_keyring' }).then((keyRing) => {
			options.keyRing = keyRing;
			options.initMenu();
			options.initGeneralSettings();
			options.initConnectedDatabases();
			options.initSpecifiedCredentialFields();
			options.initAbout();
		});
	});
});

var options = options || {};

// The background reloads the settings only after they are stored (before,
// both ran at the same time and the background could read old values).
options.saveSettings = function() {
	return options.saveSettingsPromise();
};

options.saveSettingsPromise = function() {
	return new Promise((resolve, reject) => {
		browser.storage.local.set({'settings': options.settings}).then((item) => {
			browser.runtime.sendMessage({
				action: 'load_settings'
			}).then((settings) => {
				resolve(settings);
			});
		});
	});
}

options.saveKeyRing = function() {
	return browser.storage.local.set({'keyRing': options.keyRing}).then(function() {
		return browser.runtime.sendMessage({
			action: 'load_keyring'
		});
	});
};

options.initMenu = function() {
	$(".navbar:first ul.nav:first li a").click(function(e) {
		e.preventDefault();
		$(".navbar:first ul.nav:first li").removeClass("active");
		$(this).parent("li").addClass("active");
		$("div.tab").hide();
		$("div.tab#tab-" + $(this).attr("href").substring(1)).fadeIn();
	});

	$("div.tab:first").show();
}

options.initGeneralSettings = function() {
	$("#tab-general-settings input[type=checkbox]").each(function() {
		$(this).attr("checked", options.settings[$(this).attr("name")]);
	});

	$("#tab-general-settings input[type=checkbox]").change(function() {
		var name = $(this).attr('name');
		options.settings[name] = $(this).is(':checked');
		options.saveSettingsPromise().then((x) => {
			if (name === 'autoFillAndSend') {
				browser.runtime.sendMessage({action: 'init_http_auth'});
			}
		});
	});

	$("#tab-general-settings input[type=radio]").each(function() {
		if($(this).val() == options.settings[$(this).attr("name")]) {
			$(this).attr("checked", options.settings[$(this).attr("name")]);
		}
	});

	$("#tab-general-settings input[type=radio]").change(function() {
		options.settings[$(this).attr("name")] = $(this).val();
		options.saveSettings();
	});

	browser.runtime.sendMessage({
		action: "get_keepasshttp_versions"
	}).then(options.showKeePassHttpVersions);

	$("#showDangerousSettings").click(function() {
		$('#dangerousSettings').is(":visible") ? $(this).text("Show these settings anyway") : $(this).text("Hide");
		$("#dangerousSettings").toggle();
	});

	$("#port").val(options.settings["port"]);
	$("#blinkTimeout").val(options.settings["blinkTimeout"]);
	$("#blinkMinTimeout").val(options.settings["blinkMinTimeout"]);
	$("#allowedRedirect").val(options.settings["allowedRedirect"]);

	$("#portButton").click(function() {
		var port = $.trim($("#port").val());
		var portNumber = parseInt(port);
		if(!/^[0-9]{1,5}$/.test(port) || portNumber < 1025 || portNumber > 65535) {
			$("#port").closest(".control-group").addClass("error");
			alert("The port number has to be in range 1025 - 65535.\nNothing saved!");
			return;
		}

		options.settings["port"] = portNumber.toString();
		$("#port").closest(".control-group").removeClass("error").addClass("success");
		setTimeout(function() {$("#port").closest(".control-group").removeClass("success")}, 2500);

		options.saveSettings();
	});

	$("#blinkTimeoutButton").click(function(){
		var blinkTimeout = $.trim($("#blinkTimeout").val());
		var blinkTimeoutval = parseInt(blinkTimeout);

		options.settings["blinkTimeout"] = blinkTimeoutval.toString();

		$("#blinkTimeout").closest(".control-group").removeClass("error").addClass("success");
		setTimeout(function() {$("#blinkTimeout").closest(".control-group").removeClass("success")}, 2500);

		options.saveSettings();
	});

	$("#blinkMinTimeoutButton").click(function(){
		var blinkMinTimeout = $.trim($("#blinkMinTimeout").val());
		var blinkMinTimeoutval = parseInt(blinkMinTimeout);

		options.settings["blinkMinTimeout"] = blinkMinTimeoutval.toString();
		$("#blinkMinTimeout").closest(".control-group").removeClass("error").addClass("success");
		setTimeout(function() {$("#blinkMinTimeout").closest(".control-group").removeClass("success")}, 2500);

		options.saveSettings();
	});

	$("#allowedRedirectButton").click(function(){
		var allowedRedirect = $.trim($("#allowedRedirect").val());
		var allowedRedirectval = parseInt(allowedRedirect);

		options.settings["allowedRedirect"] = allowedRedirectval.toString();
		$("#allowedRedirect").closest(".control-group").removeClass("error").addClass("success");
		setTimeout(function() {$("#allowedRedirect").closest(".control-group").removeClass("success")}, 2500);

		options.saveSettings();
	});

	if (!browser.webRequest.onAuthRequired) {
		/* onAuthRequired isn't supported on current Firefox, so hide this feature. */
		$("#http-auth-options").hide();
	}
};

options.showKeePassHttpVersions = function(response) {
	if(response.current <= 0) {
		response.current = "unknown";
	}
	$("#tab-general-settings .kphVersion:first em.yourVersion:first").text(response.current);

	$("#tab-about em.versionKPH").text(response.current);
}

options.initConnectedDatabases = function() {
	$("#dialogDeleteConnectedDatabase").modal({keyboard: true, show: false, backdrop: true});
	$("#tab-connected-databases tr.clone:first button.delete:first").click(function(e) {
		e.preventDefault();
		$("#dialogDeleteConnectedDatabase").data("hash", $(this).closest("tr").data("hash"));
		$("#dialogDeleteConnectedDatabase .modal-body:first span:first").text($(this).closest("tr").children("td:first").text());
		$("#dialogDeleteConnectedDatabase").modal("show");
	});

	$("#dialogDeleteConnectedDatabase .modal-footer:first button.yes:first").click(function(e) {
		$("#dialogDeleteConnectedDatabase").modal("hide");

		var $hash = $("#dialogDeleteConnectedDatabase").data("hash");
		$("#tab-connected-databases #tr-cd-" + $hash).remove();

		delete options.keyRing[$hash];
		options.saveKeyRing();

		if($("#tab-connected-databases table tbody:first tr").length > 2) {
			$("#tab-connected-databases table tbody:first tr.empty:first").hide();
		}
		else {
			$("#tab-connected-databases table tbody:first tr.empty:first").show();
		}
	});

	var $trClone = $("#tab-connected-databases table tr.clone:first").clone(true);
	$trClone.removeClass("clone");
	for(var hash in options.keyRing) {
		var $tr = $trClone.clone(true);
		$tr.data("hash", hash);
		$tr.attr("id", "tr-cd-" + hash);

		options.colorPicker($(".kph-color", $tr)[0], hash);

		$tr.children("td:first").text(options.keyRing[hash].id);
		var lastUsed = (options.keyRing[hash].lastUsed) ? new Date(options.keyRing[hash].lastUsed).toLocaleString() : "unknown";
		$tr.children("td:eq(2)").text(lastUsed);
		var date = (options.keyRing[hash].created) ? new Date(options.keyRing[hash].created).toLocaleDateString() : "unknown";
		$tr.children("td:eq(3)").text(date);
		$("#tab-connected-databases table tbody:first").append($tr);
	}

	if($("#tab-connected-databases table tbody:first tr").length > 2) {
		$("#tab-connected-databases table tbody:first tr.empty:first").hide();
	}
	else {
		$("#tab-connected-databases table tbody:first tr.empty:first").show();
	}
	$("#connect-button").click(function() {
		browser.runtime.sendMessage({
			action: "associate"
		});
	});
}

options.initSpecifiedCredentialFields = function() {
	$("#dialogDeleteSpecifiedCredentialFields").modal({keyboard: true, show: false, backdrop: true});
	$("#tab-specified-fields tr.clone:first button.delete:first").click(function(e) {
		e.preventDefault();
		$("#dialogDeleteSpecifiedCredentialFields").data("url", $(this).closest("tr").data("url"));
		$("#dialogDeleteSpecifiedCredentialFields").data("tr-id", $(this).closest("tr").attr("id"));
		$("#dialogDeleteSpecifiedCredentialFields .modal-body:first strong:first").text($(this).closest("tr").children("td:first").text());
		$("#dialogDeleteSpecifiedCredentialFields").modal("show");
	});

	$("#dialogDeleteSpecifiedCredentialFields .modal-footer:first button.yes:first").click(function(e) {
		$("#dialogDeleteSpecifiedCredentialFields").modal("hide");

		var $url = $("#dialogDeleteSpecifiedCredentialFields").data("url");
		var $trId = $("#dialogDeleteSpecifiedCredentialFields").data("tr-id");
		$("#tab-specified-fields #" + $trId).remove();

		delete options.settings["defined-credential-fields"][$url];
		options.saveSettings();

		if($("#tab-specified-fields table tbody:first tr").length > 2) {
			$("#tab-specified-fields table tbody:first tr.empty:first").hide();
		}
		else {
			$("#tab-specified-fields table tbody:first tr.empty:first").show();
		}
	});

	var $trClone = $("#tab-specified-fields table tr.clone:first").clone(true);
	$trClone.removeClass("clone");
	var counter = 1;
	for(var url in options.settings["defined-credential-fields"]) {
		var $tr = $trClone.clone(true);
		$tr.data("url", url);
		$tr.attr("id", "tr-scf" + counter);
		counter += 1;

		$tr.children("td:first").text(url);
		$("#tab-specified-fields table tbody:first").append($tr);
	}

	if($("#tab-specified-fields table tbody:first tr").length > 2) {
		$("#tab-specified-fields table tbody:first tr.empty:first").hide();
	}
	else {
		$("#tab-specified-fields table tbody:first tr.empty:first").show();
	}
}

options.initAbout = function() {
	var manifest = browser.runtime.getManifest();
	$("#tab-about em.versionCIP").text(manifest.version);
	browser.runtime.sendMessage({ action: 'is_firefox' }).then((isFirefox) => {
		if (isFirefox) {
			$("#chrome-web-store-link").remove();
		}
	});
}

// Toolbar icon color of one connected database: preset swatches, a custom
// "#rrggbb" field, and a preview on a light and a dark toolbar.
// Built with DOM APIs; the color is only used as a canvas or CSS color value.
options.colorPicker = function(container, hash) {
	var current = kphIcon.normalize(options.keyRing[hash].icon);

	var previews = document.createElement("div");
	previews.className = "kph-previews";
	var canvases = [false, true].map(function(dark) {
		var chip = document.createElement("span");
		chip.className = "kph-chip";
		chip.title = dark ? "Dark toolbar" : "Light toolbar";
		chip.style.background = dark ? "#2b2a33" : "#f9f9fb";
		var c = document.createElement("canvas");
		c.width = 32;
		c.height = 32;
		c.dataset.dark = dark ? "1" : "";
		chip.appendChild(c);
		previews.appendChild(chip);
		return c;
	});

	var input = document.createElement("input");
	input.type = "text";
	input.className = "kph-hex";
	input.maxLength = 7;
	input.placeholder = "#rrggbb";
	input.setAttribute("aria-label", "Custom color, #rrggbb");
	input.value = kphIcon.isHex(current) ? current : "";
	input.addEventListener("input", function() {
		var v = input.value.trim();
		var ok = kphIcon.isHex(v);
		input.classList.toggle("kph-invalid", v !== "" && !ok);
		if(ok) {
			set(v);
		}
	});

	var swatches = document.createElement("div");
	swatches.className = "kph-swatches";
	kphIcon.presets.forEach(function(p) {
		var b = document.createElement("button");
		b.type = "button";
		b.className = "kph-swatch";
		b.title = p.id;
		b.setAttribute("aria-label", p.id);
		b.dataset.color = p.id;
		b.style.background = p.light;
		b.addEventListener("click", function() {
			input.value = "";
			input.classList.remove("kph-invalid");
			set(p.id);
		});
		swatches.appendChild(b);
	});

	function draw() {
		canvases.forEach(function(c) {
			var ctx = c.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, 32, 32);
			ctx.scale(2, 2);
			kphIcon.paint(ctx, "normal", current, c.dataset.dark === "1");
		});
		Array.prototype.forEach.call(swatches.children, function(b) {
			b.classList.toggle("kph-selected", b.dataset.color === current);
		});
	}

	function set(value) {
		current = kphIcon.normalize(value);
		options.keyRing[hash].icon = current;
		options.saveKeyRing();
		draw();
	}

	container.appendChild(previews);
	container.appendChild(swatches);
	container.appendChild(input);
	draw();
};
