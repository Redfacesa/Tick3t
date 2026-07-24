import { safeStorage, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(path.join(__dirname, 'decrypt-result.json'), JSON.stringify({ok:false,error:'unavailable'}));
      app.exit(2); return;
    }
    const enc = fs.readFileSync(path.join(__dirname, '_tmp_enc.bin'));
    const plain = safeStorage.decryptString(enc);
    let token = null;
    try {
      const j = JSON.parse(plain);
      token = j.access_token || j.accessToken || (j.tokens && (j.tokens.access_token || j.tokens.accessToken));
      fs.writeFileSync(path.join(__dirname, 'decrypt-result.json'), JSON.stringify({ok:true, keys:Object.keys(j), has_token:!!token, len:plain.length}));
    } catch {
      fs.writeFileSync(path.join(__dirname, 'decrypt-result.json'), JSON.stringify({ok:true, json:false, len:plain.length}));
    }
    if (token) fs.writeFileSync(path.join(__dirname, 'token_only.txt'), token);
  } catch (e) {
    fs.writeFileSync(path.join(__dirname, 'decrypt-result.json'), JSON.stringify({ok:false,error:String(e).slice(0,300)}));
  }
  app.exit(0);
});
setTimeout(() => { try { app.exit(1); } catch {} }, 20000);
