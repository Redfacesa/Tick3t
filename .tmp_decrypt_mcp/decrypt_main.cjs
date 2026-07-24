const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const root = process.env.DECRYPT_ROOT;
const outPath = path.join(root, 'decrypt-result.json');
function finish(obj) {
  try { fs.writeFileSync(outPath, JSON.stringify(obj)); } catch {}
  try { app.exit(0); } catch {}
  process.exit(0);
}
app.whenReady().then(() => {
  const out = { ok: true, available: false, results: [] };
  try { out.available = safeStorage.isEncryptionAvailable(); } catch (e) {
    return finish({ ok: false, error: String(e) });
  }
  const targets = JSON.parse(fs.readFileSync(path.join(root, 'targets.json'), 'utf8'));
  for (const t of targets) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(t.data));
      let info = { name: t.name, ok: true, len: plain.length };
      try {
        const j = JSON.parse(plain);
        info.keys = Object.keys(j);
        const tok = j.access_token || j.accessToken || (j.tokens && (j.tokens.access_token || j.tokens.accessToken));
        info.has_token = !!tok;
        if (tok) fs.writeFileSync(path.join(root, 'token_only.txt'), tok);
        fs.writeFileSync(path.join(root, t.name + '.keys.json'), JSON.stringify({ keys: Object.keys(j), has_token: !!tok }));
      } catch {
        fs.writeFileSync(path.join(root, t.name + '.plain.txt'), plain.slice(0, 200));
        info.json = false;
      }
      out.results.push(info);
    } catch (e) {
      out.results.push({ name: t.name, ok: false, error: String(e).slice(0, 200) });
    }
  }
  finish(out);
});
setTimeout(() => finish({ ok: false, error: 'timeout' }), 20000);
