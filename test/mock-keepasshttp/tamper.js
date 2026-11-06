// Test-only response tampering (item 3: HMAC). Used by the fake server and the proxy.
// Set with POST /__mode {"tamper": "<mode>"}; "none" turns it off.
// Only successful responses (Success === true) are changed.
import crypto from 'node:crypto';

// "locked": every request gets HTTP 503, as KeePassHttp answers when the
// database is locked (KeePassHttp.cs: StatusCode = ServiceUnavailable).
export const TAMPER_MODES = ['none', 'hmac-missing', 'hmac-bad', 'nonce-swap', 'locked'];

export function tamper(mode, res) {
  if (!res || res.Success !== true || mode === 'none' || mode === 'locked') return res;
  switch (mode) {
    case 'hmac-missing':
      delete res.Hmac;
      break;
    case 'hmac-bad': {
      const b = Buffer.from(String(res.Hmac || ''), 'base64');
      if (b.length) b[0] ^= 0x01;
      res.Hmac = b.toString('base64');
      break;
    }
    case 'nonce-swap':
      // A new Nonce with the old Verifier and Hmac: the Hmac no longer matches.
      res.Nonce = crypto.randomBytes(16).toString('base64');
      break;
    default:
      throw new Error('unknown tamper mode ' + mode);
  }
  return res;
}

// Reads {"tamper": mode} from a request body; returns the mode or throws.
export function parseMode(body) {
  const m = JSON.parse(body).tamper;
  if (!TAMPER_MODES.includes(m)) throw new Error('bad mode');
  return m;
}
