// Test helper (external file: works with any CSP). Inserts a 200 px banner above the form.
setTimeout(() => {
  const b = document.createElement('div');
  b.id = 'banner';
  b.textContent = 'Banner (dummy)';
  b.setAttribute('style', 'height: 200px; background: #eee');
  document.getElementById('slot').appendChild(b);
}, 1500);
