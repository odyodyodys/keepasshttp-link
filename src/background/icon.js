// Toolbar icon, drawn at runtime from the 16x16 design paths
// (documentation/images/icons/) in the color chosen for each connected
// database. Used by the background page and by the settings page.
//
// A color is either a preset id ("blue", ...) or "#rrggbb". Anything else
// falls back to the default. The value is only used as a canvas fill color,
// never inserted into HTML or CSS text.

var kphIcon = {};

kphIcon.DEFAULT = "blue";

// Each preset has a tone for light toolbars and one for dark toolbars.
kphIcon.presets = [
	{ id: "blue",   light: "#1d4ed8", dark: "#60a5fa" },
	{ id: "purple", light: "#7c3aed", dark: "#a78bfa" },
	{ id: "green",  light: "#15803d", dark: "#4ade80" },
	{ id: "red",    light: "#b91c1c", dark: "#f87171" },
	{ id: "orange", light: "#c2410c", dark: "#fb923c" },
	{ id: "yellow", light: "#a16207", dark: "#facc15" },
	{ id: "aqua",   light: "#0e7490", dark: "#22d3ee" },
	{ id: "pink",   light: "#be185d", dark: "#f472b6" },
	{ id: "grey",   light: "#4b5563", dark: "#9ca3af" }
];

kphIcon.STATES = ["normal", "choose", "off", "save"];

kphIcon.preset = function(id) {
	for(var i = 0; i < kphIcon.presets.length; i++) {
		if(kphIcon.presets[i].id === id) {
			return kphIcon.presets[i];
		}
	}
	return null;
};

kphIcon.isHex = function(value) {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
};

// Returns a valid stored value: a preset id or a lower-case "#rrggbb".
// Old values such as "green-inverse" map to their preset.
kphIcon.normalize = function(value) {
	if(typeof value !== "string") {
		return kphIcon.DEFAULT;
	}
	var v = value.trim().toLowerCase();
	if(kphIcon.isHex(v)) {
		return v;
	}
	v = v.replace(/-inverse$/, "");
	return kphIcon.preset(v) ? v : kphIcon.DEFAULT;
};

// The fill color for a stored value. A custom color is the same on both toolbars.
kphIcon.colorFor = function(value, dark) {
	var v = kphIcon.normalize(value);
	if(v.charAt(0) === "#") {
		return v;
	}
	var p = kphIcon.preset(v);
	return dark ? p.dark : p.light;
};

kphIcon.isDarkToolbar = function() {
	try {
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	} catch(e) {
		return false;
	}
};

kphIcon.PATHS = {
	ring: "M3.5 1H6.5A2.5 2.5 0 0 1 9 3.5V6.5A2.5 2.5 0 0 1 6.5 9H3.5A2.5 2.5 0 0 1 1 6.5V3.5A2.5 2.5 0 0 1 3.5 1ZM4 3H6A1 1 0 0 1 7 4V6A1 1 0 0 1 6 7H4A1 1 0 0 1 3 6V4A1 1 0 0 1 4 3Z",
	shaft: "M8 4H14A1 1 0 0 1 15 5V8H13V6H12V8H10V6H8Z",
	dots2: "M1 13a1 1 0 1 0 2 0a1 1 0 1 0 -2 0ZM5 13a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
	dot3: "M9 13a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
	badge: "M11 9H14A2 2 0 0 1 16 11V14A2 2 0 0 1 14 16H11A2 2 0 0 1 9 14V11A2 2 0 0 1 11 9Z",
	lines: "M11 10H14V11H11ZM11 12H14V13H11ZM11 14H14V15H11Z",
	plus: "M12 10H13V12H15V13H13V15H12V13H10V12H12Z",
	cross: "M10.75 10.75L14.25 14.25M14.25 10.75L10.75 14.25"
};

// Draws one state on a 2D context, in 16x16 units (scale the context first).
kphIcon.paint = function(ctx, state, value, dark) {
	var P = kphIcon.PATHS;
	var key = (state === "off") ? "#8f8f9d" : kphIcon.colorFor(value, dark);
	var fill = function(d, color, rule) {
		ctx.fillStyle = color;
		ctx.fill(new Path2D(d), rule || "nonzero");
	};
	fill(P.ring, key, "evenodd");
	fill(P.shaft, key);
	fill(P.dots2, key);
	if(state === "normal" || kphIcon.STATES.indexOf(state) < 0) {
		fill(P.dot3, key);
		return;
	}
	var mark = dark ? "#2b2a33" : "#ffffff";
	if(state === "choose") {
		fill(P.badge, key);
		fill(P.lines, mark);
	}
	else if(state === "save") {
		fill(P.badge, "#dc2626");
		fill(P.plus, "#ffffff");
	}
	else if(state === "off") {
		fill(P.badge, dark ? "#d4d4dc" : "#5b5b66");
		ctx.strokeStyle = mark;
		ctx.lineWidth = 1.5;
		ctx.lineCap = "round";
		ctx.stroke(new Path2D(P.cross));
	}
};

// ImageData for browserAction.setIcon, for 16 and 32 px.
kphIcon.imageData = function(state, value) {
	var dark = kphIcon.isDarkToolbar();
	var out = {};
	[16, 32].forEach(function(size) {
		var canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		var ctx = canvas.getContext("2d");
		ctx.scale(size / 16, size / 16);
		kphIcon.paint(ctx, state, value, dark);
		out[size] = ctx.getImageData(0, 0, size, size);
	});
	return out;
};
