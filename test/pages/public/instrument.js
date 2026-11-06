// Records events on input fields so tests can count fills.
// Stores only field name, event type, isTrusted and value length (no values).
window.__kph = { events: [] };
for (const type of ['input', 'change', 'focus', 'blur']) {
  document.addEventListener(type, (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    window.__kph.events.push({
      type,
      field: t.name || t.id,
      trusted: e.isTrusted,
      len: t.value.length,
      t: Math.round(performance.now()),
    });
  }, true);
}
