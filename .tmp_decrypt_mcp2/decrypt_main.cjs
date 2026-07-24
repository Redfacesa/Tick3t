const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const root = __dirname;
function finish(obj) {
  try { fs.writeFileSync(path.join(root, 'decrypt-result.json'), JSON.stringify(obj)); } catch {}
  try { app.exit(0); } catch { process.exit(0); }
}
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return finish({ ok:false, error:'unavailable' });
    const enc = fs.readFileSync(path.join(root, '_tmp_enc.bin'));
    const plain = safeStorage.decryptString(enc);
    const j = JSON.parse(plain);
    const token = j.access_token || j.accessToken || (j.tokens && (j.tokens.access_token || j.tokens.accessToken));
    if (token) fs.writeFileSync(path.join(root, 'token_only.txt'), token);
    finish({ ok:true, keys:Object.keys(j), has_token:!!token });
  } catch (e) {
    finish({ ok:false, error:String(e).slice(0,400) });
  }
});
setTimeout(() => finish({ ok:false, error:'timeout' }), 20000);
