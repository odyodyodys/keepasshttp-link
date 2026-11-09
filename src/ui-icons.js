// Inline SVG icons for the settings page and the toolbar popup
// (24 x 24, stroke = currentColor). Decorative: the text next to them carries
// the meaning. The markup below is fixed text from this file, never data from
// storage or KeePass.

var kphUi = kphUi || {};

kphUi.ICONS = {
	"x-circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
	"lock": '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
	"alert-circle": '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
	"hourglass": '<path d="M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4"/>',
	"check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
	"info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
	"check": '<path d="M5 12l4 4 10-10"/>',
	"x": '<path d="M6 6l12 12M18 6L6 18"/>',
	"external": '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
	"search": '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
	"gear": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
};

kphUi.icon = function(name, size, strokeWidth) {
	var ns = "http://www.w3.org/2000/svg";
	var svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", strokeWidth || 2);
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	var parsed = new DOMParser().parseFromString('<svg xmlns="' + ns + '">' + kphUi.ICONS[name] + "</svg>", "image/svg+xml");
	Array.prototype.slice.call(parsed.documentElement.childNodes).forEach(function(n) {
		svg.appendChild(document.importNode(n, true));
	});
	return svg;
};

// The key of the toolbar icon (filled, fill = currentColor), for login rows.
kphUi.keyIcon = function(size) {
	var ns = "http://www.w3.org/2000/svg";
	var svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 -3 16 16");
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	[["M3.5 1H6.5A2.5 2.5 0 0 1 9 3.5V6.5A2.5 2.5 0 0 1 6.5 9H3.5A2.5 2.5 0 0 1 1 6.5V3.5A2.5 2.5 0 0 1 3.5 1ZM4 3H6A1 1 0 0 1 7 4V6A1 1 0 0 1 6 7H4A1 1 0 0 1 3 6V4A1 1 0 0 1 4 3Z", "evenodd"],
		["M8 4H14A1 1 0 0 1 15 5V8H13V6H12V8H10V6H8Z", "nonzero"]].forEach(function(p) {
		var path = document.createElementNS(ns, "path");
		path.setAttribute("d", p[0]);
		path.setAttribute("fill", "currentColor");
		path.setAttribute("fill-rule", p[1]);
		svg.appendChild(path);
	});
	return svg;
};

kphUi.setIcon = function(container, name, size, strokeWidth) {
	container.textContent = "";
	if(name) {
		container.appendChild(kphUi.icon(name, size, strokeWidth));
	}
};
