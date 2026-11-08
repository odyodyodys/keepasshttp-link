// Toolbar icon: one fixed color set (the design files toolbar-*-{light,dark}.svg),
// no per-database color.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

class FakePath2D { constructor(d) { this.d = d; } }

function paintLog(state, dark) {
  const { kphIcon } = loadBackground(['background/icon.js'], { Path2D: FakePath2D }, ['kphIcon']);
  const fills = [];
  const ctx = {
    set fillStyle(v) { this._fill = v; },
    fill(path) { fills.push({ color: this._fill, d: path.d }); },
    stroke(path) { fills.push({ color: this.strokeStyle, d: path.d, stroke: true }); },
  };
  kphIcon.paint(ctx, state, dark);
  return { kphIcon, fills };
}

test('the four states exist', () => {
  const { kphIcon } = loadBackground(['background/icon.js'], {}, ['kphIcon']);
  assert.deepEqual([...kphIcon.STATES].sort(), ['choose', 'normal', 'off', 'save']);
});

test('normal: blue on a light toolbar, light blue on a dark toolbar', () => {
  assert.ok(paintLog('normal', false).fills.every((f) => f.color === '#1d4ed8'));
  assert.ok(paintLog('normal', true).fills.every((f) => f.color === '#60a5fa'));
});

test('off: grey key with a badge and a cross; save: red badge', () => {
  const off = paintLog('off', false).fills;
  assert.equal(off[0].color, '#8f8f9d');
  assert.ok(off.some((f) => f.stroke));
  const save = paintLog('save', false).fills;
  assert.ok(save.some((f) => f.color === '#dc2626'));
});

test('no per-database color any more', () => {
  const { kphIcon } = loadBackground(['background/icon.js'], {}, ['kphIcon']);
  assert.equal(kphIcon.presets, undefined);
  assert.equal(kphIcon.normalize, undefined);
});
