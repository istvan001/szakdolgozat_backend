const express = require('express');
require('dotenv').config();

const telepulesKoordinatak = require('./telepules-koordinatak.json');

const telepulesNev = nev => String(nev || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const telepulesPontok = new Map(
  Object.entries(telepulesKoordinatak).map(([nev, pont]) => [
    telepulesNev(nev), pont
  ])
);

function legvonalKm(a, b) {
  const rad = fok => fok * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;
  const ertek = Math.max(0, Math.min(1, x));
  return 6371 * 2 * Math.atan2(
    Math.sqrt(ertek),
    Math.sqrt(1 - ertek)
  );
}

const mysql = require('mysql');

const cors = require('cors');

const http = require('http');

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { encryptText, decryptText, encryptFile, decryptFile } = require('./messageCrypto');

const smtp = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  }) : null;
const dbPromise = (sql, params) => new Promise((resolve, reject) =>
  db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const kodHash = (kod) => crypto.createHash('sha256').update(kod).digest('hex');
const emailCim = (ertek) => typeof ertek === 'string' ? ertek.trim().toLowerCase() : '';
const kodHelyes = (ertek) => typeof ertek === 'string' && /^\d{8}$/.test(ertek);
const kodKuldesKorlatozas = new Map();
async function kodotKuldd(user, tipus) {
  if (!smtp) throw new Error('SMTP nincs beállítva');
  const regi = await dbPromise('SELECT sent_at FROM fiok_kodok WHERE user_id = ? AND tipus = ?', [user.Id, tipus]);
  if (regi.length && Date.now() - new Date(regi[0].sent_at).getTime() < 60000) {
    console.log('[E-mail] Újraküldés kihagyva: az előző kérés óta még nem telt el 60 másodperc.');
    return false;
  }
  const kod = crypto.randomInt(0, 100000000).toString().padStart(8, '0');
  await dbPromise(`INSERT INTO fiok_kodok (user_id, tipus, kod_hash, expires_at, sent_at, attempts)
    VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW(), 0)
    ON DUPLICATE KEY UPDATE kod_hash = VALUES(kod_hash), expires_at = VALUES(expires_at), sent_at = NOW(), attempts = 0`,
    [user.Id, tipus, kodHash(kod)]);
  try {
    console.log('[E-mail] Levél átadása az SMTP-szervernek.');
    const info = await smtp.sendMail({
      from: process.env.SMTP_FROM, to: user.Email,
      subject: tipus === 'verify' ? 'Randotalk – e-mail-cím megerősítése' : 'Randotalk – új jelszó',
      text: `A Randotalk kódod: ${kod}\nA kód 10 percig használható. Ha nem te kérted, hagyd figyelmen kívül ezt az üzenetet.`
    });
    if (!info.accepted?.length) throw new Error('Az SMTP-szerver nem fogadta el a címzettet.');
    console.log('[E-mail] Az SMTP-szerver elfogadta a levelet. Ez még nem igazolja a beérkezést a postaládába.');
  } catch (error) {
    // A sikertelen küldés után azonnal lehessen új kódot kérni.
    await dbPromise('DELETE FROM fiok_kodok WHERE user_id = ? AND tipus = ? AND kod_hash = ?',
      [user.Id, tipus, kodHash(kod)]);
    throw error;
  }
  return true;
}
function kuldesEngedelyezett(req) {
  const kulcs = req.ip || 'ismeretlen';
  const most = Date.now();
  const regi = kodKuldesKorlatozas.get(kulcs) || [];
  const aktualis = regi.filter((ido) => most - ido < 3600000);
  if (aktualis.length >= 10) return false;
  aktualis.push(most);
  kodKuldesKorlatozas.set(kulcs, aktualis);
  return true;
}
async function kodEllenorzese(userId, tipus, kod) {
  if (!kodHelyes(kod)) return false;
  const sorok = await dbPromise(`SELECT kod_hash FROM fiok_kodok
    WHERE user_id = ? AND tipus = ? AND expires_at > NOW() AND attempts < 5`, [userId, tipus]);
  if (!sorok.length) return false;
  const helyes = crypto.timingSafeEqual(Buffer.from(kodHash(kod), 'hex'), Buffer.from(sorok[0].kod_hash, 'hex'));
  if (!helyes) {
    await dbPromise('UPDATE fiok_kodok SET attempts = attempts + 1 WHERE user_id = ? AND tipus = ?', [userId, tipus]);
    return false;
  }
  const felhasznalt = await dbPromise(`DELETE FROM fiok_kodok WHERE user_id = ? AND tipus = ?
    AND kod_hash = ? AND expires_at > NOW() AND attempts < 5`, [userId, tipus, sorok[0].kod_hash]);
  return felhasznalt.affectedRows === 1;
}



const app = express();



app.use(cors());

// A képek JPEG vagy GIF formátumban, legfeljebb 4 MB méretben érkezhetnek.
app.use(express.json({ limit: '6mb' }));
const kepMappa = path.join(__dirname, 'feltoltott_kepek');
fs.mkdirSync(kepMappa, { recursive: true });

const munkamenetek = new Map();
const onlineJelenlet = new Map();

function felhasznaloOnline(id) {
  const most = Date.now();

  for (const adat of onlineJelenlet.values()) {
    if (adat.aktiv &&
      most - adat.frissitve < 15000 &&
      felhasznaloTokenAlapjan(adat.token) === Number(id)) {
      return true;
    }
  }

  return false;
}

setInterval(() => {
  const most = Date.now();

  for (const [kulcs, adat] of onlineJelenlet) {
    if (most - adat.frissitve > 60000 ||
      !felhasznaloTokenAlapjan(adat.token)) {
      onlineJelenlet.delete(kulcs);
    }
  }
}, 30000).unref();
const TOKEN_ELETTARTAM = 24 * 60 * 60 * 1000;
function felhasznaloTokenAlapjan(token) {
  const adat = token && munkamenetek.get(token);
  if (!adat) return null;
  if (adat.lejarat <= Date.now()) {
    munkamenetek.delete(token);
    return null;
  }
  return adat.id;
}
function vedett(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  const id = felhasznaloTokenAlapjan(token);
  if (!id) return res.status(401).send('Jelentkezz be újra');
  req.felhasznaloId = id;
  req.munkamenetToken = token;
  next();
}
app.get('/feltoltott_kepek/:nev', vedett, (req, res) => {
  const nev = req.params.nev;
  if (!/^[0-9a-f-]{36}\.(jpg|gif)$/i.test(nev)) return res.status(404).end();
  const kepUrl = '/feltoltott_kepek/' + nev;
  const sql = `SELECT 1 FROM csevegesek c
    JOIN talalkozas t ON t.Id = c.aktualis_id
    WHERE c.kep_url = ? AND (t.id_1 = ? OR t.id_2 = ?)
    UNION SELECT 1 FROM szemelyek s WHERE s.profilkep_url = ? LIMIT 1`;
  db.query(sql, [kepUrl, req.felhasznaloId, req.felhasznaloId, kepUrl],
    (err, rows) => {
      if (err) return res.status(500).send('Adatbázis hiba');
      if (!rows.length) return res.status(403).send('Nincs hozzáférés');
      try {
        const bytes = fs.readFileSync(path.join(kepMappa, nev));
        res.type(nev.toLowerCase().endsWith('.gif') ? 'gif' : 'jpg').send(decryptFile(bytes));
      } catch (error) {
        console.error('Kép olvasási vagy visszafejtési hiba:', error);
        res.status(500).send('A kép nem olvasható');
      }
    });
});
function jelszoHash(jelszo) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(jelszo, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function jelszoHelyes(jelszo, tarolt) {
  if (!tarolt.startsWith('scrypt$')) return tarolt === jelszo; // régi fiók migrációja belépéskor
  const [, salt, hash] = tarolt.split('$');
  if (!salt || !/^[0-9a-f]{128}$/i.test(hash)) return false;
  const szamitott = crypto.scryptSync(jelszo, salt, 64);
  return crypto.timingSafeEqual(szamitott, Buffer.from(hash, 'hex'));
}






// =========================

// MYSQL KAPCSOLAT

// =========================



const db = mysql.createConnection({

  host: 'localhost',

  user: 'root',

  password: '',

  database: 'randotalk',
  charset: 'utf8mb4'

});



db.connect((err) => {

  if (err) {

    console.error('MySQL kapcsolódási hiba:', err);

    return;

  }



  console.log('MySQL kapcsolat létrejött');

});





// =========================

// WEBSOCKET

// =========================



const server = http.createServer(app);



const wss = new WebSocket.Server({

  server: server

});



// Felhasználó ID -> WebSocket kapcsolat

const kliensek = new Map();





wss.on('connection', (ws) => {



  console.log('Új WebSocket kapcsolat');



  let felhasznaloId = null;





  ws.on('message', async (message) => {



    try {



      const data = JSON.parse(message.toString());

      if (data.type === 'typing') {
        const sajatId = felhasznaloTokenAlapjan(ws.munkamenetToken);
        const partnerId = Number(data.partnerId);

        if (!sajatId) {
          ws.close(1008, 'Érvénytelen munkamenet');
          return;
        }

        if (!Number.isInteger(partnerId) || partnerId <= 0 ||
          partnerId === sajatId || typeof data.ir !== 'boolean') return;

        const most = Date.now();
        if (data.ir && most - (ws.utolsoGepeles || 0) < 500) return;
        ws.utolsoGepeles = most;

        const keresSzam = ws.gepelesKeres = (ws.gepelesKeres || 0) + 1;

        const partner = await dbPromise(
          'SELECT Id FROM szemelyek WHERE Id = ?',
          [partnerId]
        );

        if (!partner.length || await tiltottPar(sajatId, partnerId)) return;
        if (keresSzam !== ws.gepelesKeres) return;
        if (felhasznaloTokenAlapjan(ws.munkamenetToken) !== sajatId) return;

        const partnerSocket = kliensek.get(String(partnerId));

        if (partnerSocket?.readyState === WebSocket.OPEN &&
          felhasznaloTokenAlapjan(partnerSocket.munkamenetToken) === partnerId) {
          partnerSocket.send(JSON.stringify({
            type: 'typing',
            partnerId: sajatId,
            ir: data.ir
          }));
        }

        return;
      }





      // =========================

      // FELHASZNÁLÓ REGISZTRÁLÁSA

      // =========================



      if (data.type === 'register') {



        const hitelesitettId = felhasznaloTokenAlapjan(data.token);
        if (!hitelesitettId) {
          ws.close(1008, 'Érvénytelen munkamenet');
          return;
        }
        felhasznaloId = String(hitelesitettId);
        ws.munkamenetToken = data.token;



        kliensek.set(felhasznaloId, ws);



        console.log(

          'WebSocket regisztrálva, felhasználó:',

          felhasznaloId

        );



      }



    } catch (error) {



      console.error(

        'WebSocket üzenet feldolgozási hiba:',

        error

      );



    }



  });





  ws.on('close', () => {



    if (felhasznaloId) {



      // Csak akkor töröljük,

      // ha még ez a kapcsolat van eltárolva

      if (kliensek.get(felhasznaloId) === ws) {

        kliensek.delete(felhasznaloId);

      }



    }



    console.log(

      'WebSocket kapcsolat bezárva:',

      felhasznaloId

    );



  });





  ws.on('error', (error) => {



    console.error(

      'WebSocket hiba:',

      error

    );



  });



});





// =========================

// SZEMÉLYEK

// =========================



app.get('/szemelyek', vedett, (req, res) => {
  res.status(403).send('Az admin felület külön hitelesítést igényel');
});

// =========================

// LOGIN

// =========================



app.post('/login', (req, res) => {
  const nev = String(req.body.Felhasznalo || '');
  const jelszo = String(req.body.Jelszo || '');
  if (!nev || !jelszo) return res.status(400).send('Hiányzó adat');
  db.query('SELECT Id, Felhasznalo, Jelszo, email_verified, is_admin FROM szemelyek WHERE Felhasznalo = ?', [nev],
    (err, rows) => {
      if (err) return res.status(500).send('Adatbázis hiba');
      const felhasznalo = rows.find((row) => jelszoHelyes(jelszo, row.Jelszo));
      if (!felhasznalo) return res.status(401).send('Hibás felhasználónév vagy jelszó');
      if (!felhasznalo.email_verified) return res.status(403).send('Előbb erősítsd meg az e-mail-címedet.');
      const token = crypto.randomBytes(32).toString('hex');
      munkamenetek.set(token, { id: Number(felhasznalo.Id), lejarat: Date.now() + TOKEN_ELETTARTAM });
      if (!felhasznalo.Jelszo.startsWith('scrypt$')) {
        db.query('UPDATE szemelyek SET Jelszo = ? WHERE Id = ?',
          [jelszoHash(jelszo), felhasznalo.Id], (hiba) => {
            if (hiba) console.error('Régi jelszó migrációs hiba:', hiba);
          });
      }
      res.json({ token, felhasznaloId: felhasznalo.Id, felhasznaloNev: felhasznalo.Felhasznalo, admin: Number(felhasznalo.is_admin) === 1 });
    }
  );
});


async function adminVedett(req, res, next) {
  try {
    const rows = await dbPromise('SELECT is_admin FROM szemelyek WHERE Id = ?', [req.felhasznaloId]);
    if (!rows.length || Number(rows[0].is_admin) !== 1) return res.status(403).send('Adminjogosultság szükséges');
    next();
  } catch (error) { console.error('Adminjogosultság hiba:', error); res.status(500).send('Adatbázis hiba'); }
}
app.get('/admin/felhasznalok', vedett, adminVedett, async (req, res) => {
  try {
    res.json(await dbPromise('SELECT Id, Felhasznalo, Email, is_admin FROM szemelyek ORDER BY Id DESC LIMIT 500', []));
  } catch (error) { res.status(500).send('A felhasználók lekérése sikertelen'); }
});
app.get('/admin/jelentesek', vedett, adminVedett, async (req, res) => {
  try {
    res.json(await dbPromise(`SELECT j.*, a.Felhasznalo AS jelento_nev, b.Felhasznalo AS jelentett_nev
      FROM jelentesek j LEFT JOIN szemelyek a ON a.Id = j.jelento_id
      LEFT JOIN szemelyek b ON b.Id = j.jelentett_id
      ORDER BY j.letrehozva DESC, j.id DESC LIMIT 500`, []));
  } catch (error) { res.status(500).send('A jelentések lekérése sikertelen'); }
});
app.post('/admin/jelentes-allapot', vedett, adminVedett, async (req, res) => {
  const id = Number(req.body.id), allapot = req.body.allapot;
  if (!Number.isInteger(id) || id <= 0 || !['uj', 'vizsgalat', 'lezart'].includes(allapot))
    return res.status(400).send('Hibás jelentési adatok');
  try {
    const result = await dbPromise('UPDATE jelentesek SET allapot = ? WHERE id = ?', [allapot, id]);
    if (!result.affectedRows) return res.status(404).send('Nincs ilyen jelentés');
    res.json({ sikeres: true });
  } catch (error) { res.status(500).send('A jelentés módosítása sikertelen'); }
});


app.post('/admin/felhasznalo-torles', vedett, adminVedett, async (req, res) => {
  const id = Number(req.body.Id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Hibás felhasználóazonosító');
  if (id === req.felhasznaloId) return res.status(400).send('A saját adminfiókodat itt nem törölheted.');
  const kapcsolat = mysql.createConnection({
    host: db.config.host, port: db.config.port, user: db.config.user,
    password: db.config.password, database: db.config.database,
    socketPath: db.config.socketPath, charset: db.config.charset, ssl: db.config.ssl
  });
  const query = (sql, args = []) => new Promise((resolve, reject) =>
    kapcsolat.query(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  let kepek = [];
  try {
    await query('START TRANSACTION');
    const rows = await query('SELECT Id, is_admin, profilkep_url FROM szemelyek WHERE Id = ? FOR UPDATE', [id]);
    if (!rows.length) { await query('ROLLBACK'); return res.status(404).send('Nincs ilyen felhasználó'); }
    if (Number(rows[0].is_admin) === 1) { await query('ROLLBACK'); return res.status(403).send('Adminfiók nem törölhető innen.'); }
    const uzenetKepek = await query(`SELECT c.kep_url FROM csevegesek c JOIN talalkozas t ON t.Id = c.aktualis_id
      WHERE t.id_1 = ? OR t.id_2 = ?`, [id, id]);
    kepek = [rows[0].profilkep_url, ...uzenetKepek.map(x => x.kep_url)].filter(Boolean);
    await query('DELETE c FROM csevegesek c JOIN talalkozas t ON t.Id = c.aktualis_id WHERE t.id_1 = ? OR t.id_2 = ?', [id, id]);
    await query('DELETE FROM csevegesek WHERE kuldo_id = ?', [id]);
    await query('DELETE FROM talalkozas WHERE id_1 = ? OR id_2 = ?', [id, id]);
    await query('DELETE r FROM push_visszaigazolasok r JOIN push_eszkozok p ON p.push_token = r.push_token WHERE p.user_id = ?', [id]);
    await query('DELETE FROM push_eszkozok WHERE user_id = ?', [id]);
    await query('DELETE FROM fiok_kodok WHERE user_id = ?', [id]);
    await query('DELETE FROM tiltasok WHERE tilto_id = ? OR tiltott_id = ?', [id, id]);
    await query('DELETE FROM jelentesek WHERE jelento_id = ? OR jelentett_id = ?', [id, id]);
    await query('DELETE FROM szemelyek WHERE Id = ?', [id]);
    await query('COMMIT');
    const toroltTokenek = new Set();
    for (const [token, session] of munkamenetek) if (Number(session.id) === id) { toroltTokenek.add(token); munkamenetek.delete(token); }
    for (const socket of wss.clients) if (toroltTokenek.has(socket.munkamenetToken)) socket.close(1008, 'A fiókot törölték');
    kliensek.delete(String(id));
    for (const url of new Set(kepek)) {
      if (!/^\/feltoltott_kepek\/[a-zA-Z0-9.-]+$/.test(url)) continue;
      try { fs.unlinkSync(path.join(kepMappa, path.basename(url))); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Törölt fiók képének eltávolítási hibája:', error.code); }
    }
    res.json({ sikeres: true });
  } catch (error) {
    try { await query('ROLLBACK'); } catch (_) { }
    console.error('Admin fióktörlési hiba:', error);
    res.status(500).send('A törlés sikertelen.');
  } finally { kapcsolat.end(); }
});

app.post('/sajat-fiok-torles', vedett, async (req, res) => {
  const id = req.felhasznaloId;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Hibás felhasználóazonosító');
  const kapcsolat = mysql.createConnection({
    host: db.config.host, port: db.config.port, user: db.config.user,
    password: db.config.password, database: db.config.database,
    socketPath: db.config.socketPath, charset: db.config.charset, ssl: db.config.ssl
  });
  const query = (sql, args = []) => new Promise((resolve, reject) =>
    kapcsolat.query(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  let kepek = [];
  try {
    await query('START TRANSACTION');
    const rows = await query('SELECT Id, is_admin, profilkep_url FROM szemelyek WHERE Id = ? FOR UPDATE', [id]);
    if (!rows.length) { await query('ROLLBACK'); return res.status(404).send('Nincs ilyen felhasználó'); }
    if (Number(rows[0].is_admin) === 1) { await query('ROLLBACK'); return res.status(403).send('Adminfiók törlése előtt az adminjogosultságot vissza kell vonni.'); }
    const uzenetKepek = await query(`SELECT c.kep_url FROM csevegesek c JOIN talalkozas t ON t.Id = c.aktualis_id
      WHERE t.id_1 = ? OR t.id_2 = ?`, [id, id]);
    kepek = [rows[0].profilkep_url, ...uzenetKepek.map(x => x.kep_url)].filter(Boolean);
    await query('DELETE c FROM csevegesek c JOIN talalkozas t ON t.Id = c.aktualis_id WHERE t.id_1 = ? OR t.id_2 = ?', [id, id]);
    await query('DELETE FROM csevegesek WHERE kuldo_id = ?', [id]);
    await query('DELETE FROM talalkozas WHERE id_1 = ? OR id_2 = ?', [id, id]);
    await query('DELETE r FROM push_visszaigazolasok r JOIN push_eszkozok p ON p.push_token = r.push_token WHERE p.user_id = ?', [id]);
    await query('DELETE FROM push_eszkozok WHERE user_id = ?', [id]);
    await query('DELETE FROM fiok_kodok WHERE user_id = ?', [id]);
    await query('DELETE FROM tiltasok WHERE tilto_id = ? OR tiltott_id = ?', [id, id]);
    await query('DELETE FROM jelentesek WHERE jelento_id = ? OR jelentett_id = ?', [id, id]);
    await query('DELETE FROM szemelyek WHERE Id = ?', [id]);
    await query('COMMIT');
    const toroltTokenek = new Set();
    for (const [token, session] of munkamenetek) if (Number(session.id) === id) { toroltTokenek.add(token); munkamenetek.delete(token); }
    for (const socket of wss.clients) if (toroltTokenek.has(socket.munkamenetToken)) socket.close(1008, 'A fiókot törölték');
    kliensek.delete(String(id));
    for (const url of new Set(kepek)) {
      if (!/^\/feltoltott_kepek\/[a-zA-Z0-9.-]+$/.test(url)) continue;
      try { fs.unlinkSync(path.join(kepMappa, path.basename(url))); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Törölt fiók képének eltávolítási hibája:', error.code); }
    }
    res.json({ sikeres: true });
  } catch (error) {
    try { await query('ROLLBACK'); } catch (_) { }
    console.error('Admin fióktörlési hiba:', error);
    res.status(500).send('A törlés sikertelen.');
  } finally { kapcsolat.end(); }
});

app.post('/logout', vedett, (req, res) => {
  munkamenetek.delete(req.munkamenetToken);
  const ws = kliensek.get(String(req.felhasznaloId));
  if (ws && ws.munkamenetToken === req.munkamenetToken) ws.close(1008, 'Kijelentkezés');
  res.json({ sikeres: true });
});

app.post('/push-token', vedett, async (req, res) => {
  const pushToken = req.body.pushToken;
  if (typeof pushToken !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(pushToken))
    return res.status(400).send('Hibás értesítési token');
  try {
    await dbPromise(`INSERT INTO push_eszkozok (push_token, user_id) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`, [pushToken, req.felhasznaloId]);
    res.json({ sikeres: true });
  } catch (error) { console.error('Push token mentési hiba:', error); res.status(500).send('Nem sikerült menteni'); }
});
app.post('/push-token-torles', vedett, async (req, res) => {
  try {
    await dbPromise('DELETE FROM push_eszkozok WHERE push_token = ? AND user_id = ?', [req.body.pushToken, req.felhasznaloId]);
    res.json({ sikeres: true });
  } catch (error) { res.status(500).send('Nem sikerült törölni'); }
});
app.post('/uzenetek-olvasott', vedett, async (req, res) => {
  const id = Number(req.body.talalkozasId), maxId = Number(req.body.utolsoUzenetId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(maxId) || maxId <= 0)
    return res.status(400).send('Hibás üzenetazonosító');
  try {
    const jogosult = await dbPromise('SELECT Id FROM talalkozas WHERE Id = ? AND (id_1 = ? OR id_2 = ?)',
      [id, req.felhasznaloId, req.felhasznaloId]);
    if (!jogosult.length) return res.status(403).send('Nincs hozzáférés');
    await dbPromise('UPDATE csevegesek SET olvasott = 1 WHERE aktualis_id = ? AND id <= ? AND kuldo_id <> ?',
      [id, maxId, req.felhasznaloId]);
    res.json({ sikeres: true });
  } catch (error) { console.error('Olvasási jelölés hiba:', error); res.status(500).send('Adatbázis hiba'); }
});

async function pushErtesites(partnerId, felhasznaloId, talalkozasId) {
  try {
    const eszkozok = await dbPromise('SELECT push_token FROM push_eszkozok WHERE user_id = ?', [partnerId]);
    console.log('[Push] Címzett:', partnerId, 'Eszközök:', eszkozok.length);
    for (let kezdet = 0; kezdet < eszkozok.length; kezdet += 100) {
      const adag = eszkozok.slice(kezdet, kezdet + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(adag.map((e) => ({
          to: e.push_token, title: 'Randotalk',
          body: 'Új üzeneted érkezett.', sound: 'default', channelId: 'uzenetek', priority: 'high',
          data: { talalkozasId, partnerId: felhasznaloId }
        })))
      });
      if (!response.ok) throw new Error('Expo push HTTP ' + response.status);
      const valasz = await response.json();
      if (!Array.isArray(valasz.data)) throw new Error('Érvénytelen Expo push válasz');
      for (let i = 0; i < valasz.data.length; i++) {
        const ticket = valasz.data[i];
        if (ticket.status === 'ok') {
          await dbPromise('INSERT IGNORE INTO push_visszaigazolasok (id, push_token, ellenorzes) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))',
            [ticket.id, adag[i].push_token]);
        } else {
          console.error('Push értesítési hiba:', ticket.details?.error || ticket.message);
          if (ticket.details?.error === 'DeviceNotRegistered')
            await dbPromise('DELETE FROM push_eszkozok WHERE push_token = ?', [adag[i].push_token]);
        }
      }
    }
  } catch (error) { console.error('Push küldési hiba:', error.message); }
}
// Az Expo átvételi jegye még nem kézbesítési visszaigazolás.
setInterval(async () => {
  try {
    const rows = await dbPromise('SELECT id, push_token FROM push_visszaigazolasok WHERE ellenorzes <= NOW() LIMIT 100', []);
    if (!rows.length) return;
    const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify({ ids: rows.map((r) => r.id) })
    });
    if (!response.ok) return;
    const valasz = await response.json();
    for (const row of rows) {
      const receipt = valasz.data?.[row.id];
      if (receipt?.status === 'error') {
        console.error('Push kézbesítési hiba:', receipt.details?.error || receipt.message);
        if (receipt.details?.error === 'DeviceNotRegistered') await dbPromise('DELETE FROM push_eszkozok WHERE push_token = ?', [row.push_token]);
      }
      if (receipt) await dbPromise('DELETE FROM push_visszaigazolasok WHERE id = ?', [row.id]);
      else await dbPromise('UPDATE push_visszaigazolasok SET ellenorzes = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?', [row.id]);
    }
  } catch (error) { console.error('Push visszaigazolási hiba:', error.message); }
}, 60000).unref();


// =========================

// FELHASZNÁLÓ TÖRLÉSE

// =========================



app.post('/delete', vedett, (req, res) => {
  if (Number(req.body.Id) !== req.felhasznaloId) {
    return res.status(403).send('Csak a saját fiókod törölheted');
  }



  const sql = `

    DELETE FROM szemelyek

    WHERE Id = ?;

  `;



  db.query(

    sql,

    [req.body.Id],

    (err, rows) => {



      if (err) {

        console.error('Törlési hiba:', err);

        return res.status(500).send(err);

      }



      res.send(rows);



      console.log(

        'Felhasználó törölve:',

        req.body.Id

      );



    }

  );



});





// =========================

// REGISZTRÁCIÓ

// =========================



app.post('/regisztracio-kod', async (req, res) => {
  const nev = String(req.body.Felhasznalo || '').trim();
  const email = emailCim(req.body.Email);
  const jelszo = req.body.Jelszo;
  if (!nev || nev.length > 100 || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof jelszo !== 'string' || jelszo.length < 8 || jelszo.length > 100 || jelszo !== req.body.JelszoUjra)
    return res.status(400).send('Érvényes e-mail-cím, felhasználónév és két egyező, legalább 8 karakteres jelszó szükséges.');
  if (!kuldesEngedelyezett(req)) return res.status(429).send('Túl sok kérés. Próbáld később.');
  if (!smtp) return res.status(503).send('Az e-mail küldés nincs beállítva.');
  try {
    const foglalt = await dbPromise('SELECT Id FROM szemelyek WHERE Email = ? OR Felhasznalo = ? LIMIT 1', [email, nev]);
    if (foglalt.length) return res.status(409).send('A felhasználónév vagy e-mail-cím már foglalt.');
    const elozo = await dbPromise('SELECT sent_at FROM regisztracio_kodok WHERE email = ? ORDER BY sent_at DESC LIMIT 1', [email]);
    if (elozo.length && Date.now() - new Date(elozo[0].sent_at).getTime() < 60000)
      return res.status(429).send('Új kódot 60 másodperc elteltével kérhetsz.');
    const id = crypto.randomUUID();
    const kod = crypto.randomInt(0, 100000000).toString().padStart(8, '0');
    await dbPromise('DELETE FROM regisztracio_kodok WHERE expires_at < NOW()', []);
    await dbPromise(`INSERT INTO regisztracio_kodok (id, email, felhasznalo, jelszo_hash, kod_hash, expires_at, sent_at)
      VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW())`, [id, email, nev, jelszoHash(jelszo), kodHash(kod)]);
    try {
      const info = await smtp.sendMail({
        from: process.env.SMTP_FROM, to: email,
        subject: 'Randotalk – e-mail-cím megerősítése',
        text: `A regisztrációs kódod: ${kod}\nA kód 10 percig érvényes. Ha nem te kérted, hagyd figyelmen kívül.`
      });
      if (!info.accepted?.length) throw new Error('A címzettet az SMTP-szerver nem fogadta el.');
    } catch (error) {
      await dbPromise('DELETE FROM regisztracio_kodok WHERE id = ?', [id]);
      throw error;
    }
    console.log('[E-mail] Regisztrációs levél elfogadva az SMTP-szerveren.');
    res.json({ regisztracioId: id });
  } catch (error) {
    console.error('Regisztrációs kódküldési hiba:', error);
    res.status(503).send('Nem sikerült elküldeni a kódot. Próbáld később.');
  }
});

app.post('/regisztracio-ellenorzes', async (req, res) => {
  if (typeof req.body.regisztracioId !== 'string' || !kodHelyes(req.body.kod))
    return res.status(400).send('Hibás kód');
  try {
    const token = crypto.randomBytes(32).toString('hex');
    // Egyetlen adatbázis-művelet ellenőrzi és használja fel a kódot.
    const eredmeny = await dbPromise(`UPDATE regisztracio_kodok SET kod_hash = NULL, igazolas_hash = ?,
      expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE)
      WHERE id = ? AND kod_hash = ? AND expires_at > NOW() AND attempts < 5`,
      [kodHash(token), req.body.regisztracioId, kodHash(req.body.kod)]);
    if (!eredmeny.affectedRows) {
      await dbPromise('UPDATE regisztracio_kodok SET attempts = LEAST(attempts + 1, 5) WHERE id = ? AND kod_hash IS NOT NULL', [req.body.regisztracioId]);
      return res.status(400).send('Hibás vagy lejárt kód. Kérj új kódot, ha elérted az 5 próbálkozást.');
    }
    res.json({ igazolasToken: token });
  } catch (error) {
    console.error('Regisztrációs igazolási hiba:', error);
    res.status(500).send('Az igazolás nem sikerült');
  }
});

app.post('/szemelyfelvi', async (req, res) => {
  const Felhasznalo = String(req.body.Felhasznalo || '').trim();
  const Email = emailCim(req.body.Email);
  const Jelszo = String(req.body.Jelszo || '');
  const nem = req.body.nem || null;
  const lakhely = req.body.lakhely ? String(req.body.lakhely).trim() : null;
  const eletkor = req.body.eletkor == null ? null : Number(req.body.eletkor);
  const profilkepBase64 = req.body.profilkepBase64;

  if (!Felhasznalo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(Email) || !Jelszo || Felhasznalo.length > 100 ||
    Email.length > 200 || Jelszo.length > 100 ||
    (lakhely && lakhely.length > 100) ||
    (nem && !['Nő', 'Férfi', 'Egyéb'].includes(nem)) ||
    (eletkor !== null && (!Number.isInteger(eletkor) || eletkor < 18 || eletkor > 80))) {
    return res.status(400).send('Hiányzó vagy hibás regisztrációs adat');
  }
  let igazolas;
  try {
    if (typeof req.body.igazolasToken !== 'string' || !/^[0-9a-f]{64}$/.test(req.body.igazolasToken))
      return res.status(403).send('Előbb igazold az e-mail-címedet.');
    const rows = await dbPromise(`SELECT id, jelszo_hash FROM regisztracio_kodok
      WHERE id = ? AND email = ? AND felhasznalo = ? AND igazolas_hash = ? AND expires_at > NOW()`,
      [req.body.regisztracioId, Email, Felhasznalo, kodHash(req.body.igazolasToken)]);
    igazolas = rows[0];
    if (!igazolas || !jelszoHelyes(Jelszo, igazolas.jelszo_hash))
      return res.status(403).send('Az igazolás lejárt vagy megváltoztak a belépési adatok. Kezdd újra a regisztrációt.');
    const foglalt = await dbPromise('SELECT Id FROM szemelyek WHERE Email = ? OR Felhasznalo = ? LIMIT 1', [Email, Felhasznalo]);
    if (foglalt.length) return res.status(409).send('A felhasználónév vagy e-mail-cím már foglalt.');
  } catch (error) {
    console.error('Regisztráció ellenőrzési hiba:', error);
    return res.status(500).send('Adatbázis hiba');
  }

  let profilkepUrl = null;
  let profilkepFajl = null;
  if (profilkepBase64) {
    if (typeof profilkepBase64 !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(profilkepBase64) ||
      profilkepBase64.length > 5600000) {
      return res.status(400).send('Érvénytelen vagy túl nagy profilkép');
    }
    const bytes = Buffer.from(profilkepBase64, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || bytes.length < 4 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      return res.status(400).send('Legfeljebb 4 MB-os JPEG kép tölthető fel');
    }
    const nev = crypto.randomUUID() + '.jpg';
    profilkepFajl = path.join(kepMappa, nev);
    try {
      fs.writeFileSync(profilkepFajl, encryptFile(bytes), { flag: 'wx' });
    } catch (error) {
      console.error('Profilkép mentési hiba:', error);
      return res.status(500).send('A profilkép mentése sikertelen');
    }
    profilkepUrl = '/feltoltott_kepek/' + nev;
  }

  const sql = `INSERT INTO szemelyek
    (Felhasznalo, Jelentesek, Email, Jelszo, nem, lakhely, eletkor, profilkep_url, email_verified)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?, 1)`;
  db.query(sql, [Felhasznalo, Email, igazolas.jelszo_hash, nem, lakhely, eletkor, profilkepUrl],
    async (err, result) => {
      if (err) {
        if (profilkepFajl) fs.unlink(profilkepFajl, () => { });
        console.error('Regisztrációs hiba:', err);
        return res.status(err.code === 'ER_DUP_ENTRY' ? 409 : 500).send(err.code === 'ER_DUP_ENTRY' ? 'A felhasználónév vagy e-mail-cím már foglalt.' : 'Nem sikerült regisztrálni');
      }
      db.query('DELETE FROM regisztracio_kodok WHERE id = ?', [igazolas.id], (hiba) => {
        if (hiba) console.error('Regisztrációs igazolás takarítási hiba:', hiba);
      });

      let ujTalalkozasId = null;

      try {
        const adminok = await dbPromise(
          'SELECT Id FROM szemelyek WHERE is_admin = 1 ORDER BY Id ASC LIMIT 1',
          []
        );

        if (adminok.length) {
          const adminId = Number(adminok[0].Id);
          const ujFelhasznaloId = Number(result.insertId);

          const talalkozas = await dbPromise(
            'INSERT INTO talalkozas (id_1, id_2, kezdes) VALUES (?, ?, NOW())',
            [adminId, ujFelhasznaloId]
          );

          ujTalalkozasId = talalkozas.insertId;

          const koszonto =
            `Szia ${Felhasznalo}! Üdv a RandoTalkban!\n\n` +
            'Keress új beszélgetőpartnereket, és ismerkedj a saját tempódban. ' +
            'Ha kérdésed van vagy problémát tapasztalsz, ebben a beszélgetésben írhatsz nekünk.\n\n' +
            'Jó beszélgetést!';

          await dbPromise(
            `INSERT INTO csevegesek
              (aktualis_id, kuldo_id, uzenet, kep_url, olvasott)
             VALUES (?, ?, ?, NULL, 0)`,
            [ujTalalkozasId, adminId, encryptText(koszonto)]
          );
        } else {
          console.warn('Köszöntő üzenet kihagyva: nincs adminfiók.');
        }
      } catch (error) {
        console.error('Köszöntő üzenet küldési hiba:', error);

        if (ujTalalkozasId !== null) {
          try {
            await dbPromise(
              `DELETE FROM talalkozas
               WHERE Id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM csevegesek WHERE aktualis_id = ?
                 )`,
              [ujTalalkozasId, ujTalalkozasId]
            );
          } catch (torlesiHiba) {
            console.error('Üres köszöntő beszélgetés törlési hiba:', torlesiHiba);
          }
        }
      }

      res.json({ sikeres: true });
    }
  );
});

// A válasz a jelszóemlékeztetőnél akkor is azonos, ha nincs ilyen e-mail-cím.
app.post('/kod-keres', async (req, res) => {
  console.log('[E-mail] Kódkérés megérkezett a backendhez.');
  const Email = emailCim(req.body.Email);
  const tipus = req.body.tipus;
  if (!Email || Email.length > 200 || !['verify', 'reset'].includes(tipus))
    return res.status(400).send('Hibás kérés');
  if (!kuldesEngedelyezett(req)) return res.status(429).send('Túl sok kérés, próbáld később.');
  try {
    if (!smtp) return res.status(503).send('Az e-mail küldés nincs beállítva.');
    const rows = await dbPromise('SELECT Id, Email, email_verified FROM szemelyek WHERE Email = ? LIMIT 1', [Email]);
    const user = rows[0];
    if (!user) {
      console.log('[E-mail] Nincs fiók a megadott e-mail-címmel.');
    } else if (tipus === 'verify' && user.email_verified) {
      console.log('[E-mail] A fiók e-mail-címe már megerősített; igazoló kódot nem küldünk.');
    } else {
      console.log('[E-mail] Fiók megtalálva; kód típusa:', tipus);
      await kodotKuldd(user, tipus);
    }
    res.json({ uzenet: 'Ha a címhez tartozik megfelelő fiók, elküldtük a kódot. A kód 10 percig érvényes.' });
  } catch (error) {
    console.error('Kódküldési hiba:', error);
    res.status(503).send('Az e-mail küldése most nem sikerült. Próbáld meg később.');
  }
});

app.post('/email-megerosites', async (req, res) => {
  const Email = emailCim(req.body.Email);
  const kod = req.body.kod;
  if (!Email || !kodHelyes(kod)) return res.status(400).send('Hibás kód');
  try {
    const rows = await dbPromise('SELECT Id, email_verified FROM szemelyek WHERE Email = ? LIMIT 1', [Email]);
    if (!rows.length || rows[0].email_verified || !await kodEllenorzese(rows[0].Id, 'verify', kod))
      return res.status(400).send('Hibás vagy lejárt kód');
    await dbPromise('UPDATE szemelyek SET email_verified = 1 WHERE Id = ?', [rows[0].Id]);
    res.json({ sikeres: true });
  } catch (error) {
    console.error('E-mail igazolási hiba:', error);
    res.status(500).send('Az igazolás most nem sikerült');
  }
});

app.post('/jelszo-visszaallitas', async (req, res) => {
  const Email = emailCim(req.body.Email);
  const kod = req.body.kod;
  const ujJelszo = req.body.ujJelszo;
  if (!Email || !kodHelyes(kod) || typeof ujJelszo !== 'string' || ujJelszo.length < 8 || ujJelszo.length > 100)
    return res.status(400).send('A kód 8 számjegyű, az új jelszó legalább 8 karakter legyen.');
  try {
    const rows = await dbPromise('SELECT Id FROM szemelyek WHERE Email = ? LIMIT 1', [Email]);
    if (!rows.length || !await kodEllenorzese(rows[0].Id, 'reset', kod))
      return res.status(400).send('Hibás vagy lejárt kód');
    await dbPromise('UPDATE szemelyek SET Jelszo = ? WHERE Id = ?', [jelszoHash(ujJelszo), rows[0].Id]);
    for (const [token, adat] of munkamenetek) if (adat.id === Number(rows[0].Id)) munkamenetek.delete(token);
    const ws = kliensek.get(String(rows[0].Id));
    if (ws) ws.close(1008, 'Jelszó megváltozott');
    res.json({ sikeres: true });
  } catch (error) {
    console.error('Jelszó visszaállítási hiba:', error);
    res.status(500).send('A jelszó visszaállítása most nem sikerült');
  }
});

app.get('/profil/:id', vedett, async (req, res) => {
  const partnerId = Number(req.params.id);
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0)
    return res.status(400).send('Hibás felhasználóazonosító');

  try {
    const rows = await dbPromise(`
      SELECT s.Id, s.Felhasznalo, s.nem, s.lakhely,
        s.eletkor, s.profilkep_url,
        en.lakhely AS sajatLakhely
      FROM szemelyek s
      JOIN szemelyek en ON en.Id = ?
      WHERE s.Id = ?
      LIMIT 1
    `, [req.felhasznaloId, partnerId]);

    if (!rows.length)
      return res.status(404).send('A profil nem található');

    const { sajatLakhely, ...profil } = rows[0];
    const sajatPont = telepulesPontok.get(telepulesNev(sajatLakhely));
    const partnerPont = telepulesPontok.get(telepulesNev(profil.lakhely));

    let tavolsagKm = null;
    if (partnerId !== req.felhasznaloId && sajatPont && partnerPont) {
      const tavolsag = legvonalKm(sajatPont, partnerPont);
      if (Number.isFinite(tavolsag))
        tavolsagKm = Math.round(tavolsag);
    }

    res.json({ ...profil, tavolsagKm });
  } catch (error) {
    console.error('Profil lekérési hiba:', error);
    res.status(500).send('A profil lekérése sikertelen');
  }
});


// =========================

// RANDOM PARTNER KERESÉSE

// =========================




// Tiltás mindkét irányban megakadályozza az új üzeneteket.
const tiltottPar = async (a, b) => (await dbPromise(
  'SELECT 1 FROM tiltasok WHERE (tilto_id = ? AND tiltott_id = ?) OR (tilto_id = ? AND tiltott_id = ?) LIMIT 1',
  [a, b, b, a])).length > 0;

app.post('/tiltas', vedett, async (req, res) => {
  const partnerId = Number(req.body.partnerId);
  if (!Number.isInteger(partnerId) || partnerId <= 0 || partnerId === req.felhasznaloId)
    return res.status(400).send('Hibás partner');
  try {
    const rows = await dbPromise('SELECT Id FROM szemelyek WHERE Id = ?', [partnerId]);
    if (!rows.length) return res.status(404).send('A partner nem található');
    await dbPromise('INSERT IGNORE INTO tiltasok (tilto_id, tiltott_id) VALUES (?, ?)', [req.felhasznaloId, partnerId]);
    res.json({ sikeres: true });
  } catch (error) { console.error('Tiltási hiba:', error); res.status(500).send('A tiltás mentése sikertelen'); }
});

app.post('/jelentes', vedett, async (req, res) => {
  const partnerId = Number(req.body.partnerId);
  const talalkozasId = Number(req.body.talalkozasId);
  const ok = req.body.ok;
  const leiras = typeof req.body.leiras === 'string' ? req.body.leiras.trim() : '';
  if (!Number.isInteger(partnerId) || partnerId <= 0 || partnerId === req.felhasznaloId ||
    !Number.isInteger(talalkozasId) || talalkozasId <= 0 ||
    !['Zaklatás', 'Sértő tartalom', 'Spam', 'Egyéb'].includes(ok) || leiras.length > 1000)
    return res.status(400).send('Hibás jelentési adatok');
  try {
    const rows = await dbPromise('SELECT Id FROM talalkozas WHERE Id = ? AND ((id_1 = ? AND id_2 = ?) OR (id_1 = ? AND id_2 = ?))',
      [talalkozasId, req.felhasznaloId, partnerId, partnerId, req.felhasznaloId]);
    if (!rows.length) return res.status(403).send('Nincs hozzáférés ehhez a beszélgetéshez');
    await dbPromise('INSERT INTO jelentesek (jelento_id, jelentett_id, talalkozas_id, ok, leiras) VALUES (?, ?, ?, ?, ?)',
      [req.felhasznaloId, partnerId, talalkozasId, ok, leiras]);
    res.json({ sikeres: true });
  } catch (error) { console.error('Jelentési hiba:', error); res.status(500).send('A jelentés mentése sikertelen'); }
});

// A tiltást a szerver ellenőrzi, ezért más kliensből sem kerülhető meg.
app.post('/uzenet', vedett, async (req, res, next) => {
  try {
    if (await tiltottPar(req.felhasznaloId, Number(req.body.partnerId)))
      return res.status(403).send('Tiltás miatt nem küldhető üzenet ennek a partnernek.');
    next();
  } catch (error) { console.error('Tiltás ellenőrzési hiba:', error); res.status(500).send('Adatbázis hiba'); }
});

app.get('/random/:id', vedett, async (req, res) => {
  const id = req.felhasznaloId;
  if (Number(req.params.id) !== id)
    return res.status(403).send('Nincs hozzáférés');

  try {
    const sajatSorok = await dbPromise(`
      SELECT s.lakhely, s.eletkor,
        COALESCE(p.kor_min, 18) AS korMin,
        COALESCE(p.kor_max, 80) AS korMax,
        COALESCE(p.tavolsag_km, 50) AS tavolsagKm
      FROM szemelyek s
      LEFT JOIN partner_keresesi_beallitasok p
        ON p.felhasznalo_id = s.Id
      WHERE s.Id = ?
    `, [id]);

    if (!sajatSorok.length)
      return res.status(404).send('A profil nem található');

    const sajat = sajatSorok[0];
    const sajatPont = telepulesPontok.get(telepulesNev(sajat.lakhely));

    if (!sajatPont)
      return res.status(400).send(
        'A profilod településéhez nem található koordináta. Ellenőrizd a profilban megadott települést.'
      );

    const jeloltek = await dbPromise(`
      SELECT s.Id AS partnerId, s.Felhasznalo AS partnerNev,
        s.lakhely, s.eletkor,
        COALESCE(p.kor_min, 18) AS korMin,
        COALESCE(p.kor_max, 80) AS korMax,
        COALESCE(p.tavolsag_km, 50) AS tavolsagKm
      FROM szemelyek s
      LEFT JOIN partner_keresesi_beallitasok p
        ON p.felhasznalo_id = s.Id
      WHERE s.Id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM tiltasok b
          WHERE (b.tilto_id = ? AND b.tiltott_id = s.Id)
             OR (b.tiltott_id = ? AND b.tilto_id = s.Id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM talalkozas t
          WHERE (t.id_1 = ? AND t.id_2 = s.Id)
             OR (t.id_2 = ? AND t.id_1 = s.Id)
        )
    `, [id, id, id, id, id]);

    const talalatok = jeloltek.filter(jelolt => {
      const jeloltPont = telepulesPontok.get(
        telepulesNev(jelolt.lakhely)
      );
      if (!jeloltPont) return false;

      const tavolsag = legvonalKm(sajatPont, jeloltPont);
      if (tavolsag > Number(sajat.tavolsagKm) ||
        tavolsag > Number(jelolt.tavolsagKm)) return false;

      const partnerKorMegfelel = jelolt.eletkor == null
        ? Number(sajat.korMin) === 18 && Number(sajat.korMax) === 80
        : Number(jelolt.eletkor) >= Number(sajat.korMin) &&
        Number(jelolt.eletkor) <= Number(sajat.korMax);

      const sajatKorMegfelel = sajat.eletkor == null
        ? Number(jelolt.korMin) === 18 && Number(jelolt.korMax) === 80
        : Number(sajat.eletkor) >= Number(jelolt.korMin) &&
        Number(sajat.eletkor) <= Number(jelolt.korMax);

      return partnerKorMegfelel && sajatKorMegfelel;
    });

    if (!talalatok.length)
      return res.status(404).send(
        'Nincs a keresési beállításoknak megfelelő új partner'
      );

    const partner = talalatok[
      Math.floor(Math.random() * talalatok.length)
    ];

    res.json({
      partnerId: partner.partnerId,
      partnerNev: partner.partnerNev
    });
  } catch (error) {
    console.error('Partnerkeresési hiba:', error);
    res.status(500).send('A partnerkeresés sikertelen');
  }
});

// =========================

// ÜZENET KÜLDÉSE

// =========================



app.post('/uzenet', vedett, async (req, res) => {



  const felhasznaloId = req.felhasznaloId;



  const partnerId = Number(req.body.partnerId);
  if (!Number.isInteger(partnerId) || partnerId <= 0 || partnerId === felhasznaloId) {
    return res.status(400).send('Hibás partner');
  }

  let valasz = null;

  if (req.body.valaszUzenetId != null) {
    const valaszId = req.body.valaszUzenetId;

    if (!Number.isInteger(valaszId) || valaszId <= 0) {
      return res.status(400).send('Hibás válaszüzenet-azonosító');
    }

    try {
      const sorok = await dbPromise(`
      SELECT c.id, c.aktualis_id, c.kuldo_id, c.uzenet, c.kep_url
      FROM csevegesek c
      JOIN talalkozas t ON t.Id = c.aktualis_id
      WHERE c.id = ? AND c.visszavont = 0
        AND (
          (t.id_1 = ? AND t.id_2 = ?)
          OR (t.id_1 = ? AND t.id_2 = ?)
        )
      LIMIT 1
    `, [
        valaszId,
        felhasznaloId,
        partnerId,
        partnerId,
        felhasznaloId
      ]);

      if (!sorok.length) {
        return res.status(403).send(
          'Erre az üzenetre ebben a beszélgetésben nem válaszolhatsz.'
        );
      }

      valasz = {
        ...sorok[0],
        uzenet: decryptText(sorok[0].uzenet).slice(0, 300)
      };
    } catch (error) {
      console.error('Válaszüzenet ellenőrzési hiba:', error);
      return res.status(500).send(
        'A válaszüzenet ellenőrzése sikertelen'
      );
    }
  }

  const uzenet = typeof req.body.uzenet === 'string' ? req.body.uzenet.trim() : '';
  const kepBase64 = req.body.kepBase64;
  const kepFormat = req.body.kepFormat || 'jpeg';
  let kepUrl = null;
  if (kepBase64 !== undefined) {
    if (typeof kepBase64 !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(kepBase64) ||
      kepBase64.length > 5600000) {
      return res.status(400).send('Érvénytelen vagy túl nagy kép');
    }
    const bytes = Buffer.from(kepBase64, 'base64');
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    const gif = bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) &&
      bytes[bytes.length - 1] === 0x3b;
    if (bytes.length > 4 * 1024 * 1024 ||
      !((kepFormat === 'jpeg' && jpeg) || (kepFormat === 'gif' && gif))) {
      return res.status(400).send('Legfeljebb 4 MB-os JPEG kép vagy GIF küldhető');
    }
    const nev = crypto.randomUUID() + (kepFormat === 'gif' ? '.gif' : '.jpg');
    try {
      fs.writeFileSync(path.join(kepMappa, nev), encryptFile(bytes), { flag: 'wx' });
    } catch (error) {
      console.error('Kép mentési hiba:', error);
      return res.status(500).send('A kép mentése sikertelen');
    }
    kepUrl = '/feltoltott_kepek/' + nev;
  }





  if (

    !felhasznaloId ||

    !partnerId ||

    (!uzenet && !kepUrl)

  ) {



    return res

      .status(400)

      .send('Hiányzó adat');



  }





  // =========================

  // MEGNÉZZÜK, VAN-E MÁR BESZÉLGETÉS

  // =========================



  const keresSql = `

    SELECT Id

    FROM talalkozas



    WHERE

      (

        id_1 = ?

        AND

        id_2 = ?

      )



      OR



      (

        id_1 = ?

        AND

        id_2 = ?

      )



    LIMIT 1

  `;





  db.query(

    keresSql,

    [

      felhasznaloId,

      partnerId,

      partnerId,

      felhasznaloId

    ],

    (err, rows) => {



      if (err) {



        console.error(

          'Találkozás keresési hiba:',

          err

        );



        return res

          .status(500)

          .send('Adatbázis hiba');



      }





      // =========================

      // MÉG NINCS BESZÉLGETÉS

      // =========================



      if (rows.length === 0) {



        const talalkozasSql = `

          INSERT INTO talalkozas

          (

            id_1,

            id_2,

            kezdes

          )



          VALUES

          (

            ?,

            ?,

            NOW()

          )

        `;





        db.query(

          talalkozasSql,

          [

            felhasznaloId,

            partnerId

          ],

          (err, result) => {



            if (err) {



              console.error(

                'Találkozás létrehozási hiba:',

                err

              );



              return res

                .status(500)

                .send(

                  'Találkozás létrehozási hiba'

                );



            }





            const talalkozasId =

              result.insertId;





            uzenetMentese(

              talalkozasId,
              felhasznaloId,
              partnerId,
              uzenet,
              kepUrl,
              res,
              valasz

            );



          }

        );



      }



      // =========================

      // MÁR VAN BESZÉLGETÉS

      // =========================



      else {



        const talalkozasId =

          rows[0].Id;





        uzenetMentese(

          talalkozasId,

          felhasznaloId,

          partnerId,

          uzenet,
          kepUrl,
          res,
          valasz

        );



      }



    }

  );



});





// =========================

// ÜZENET MENTÉSE

// =========================



function uzenetMentese(
  talalkozasId,
  felhasznaloId,
  partnerId,
  uzenet,
  kepUrl,
  res,
  valasz = null
) {
  if (valasz &&
    Number(valasz.aktualis_id) !== Number(talalkozasId)) {
    if (kepUrl) {
      fs.unlink(
        path.join(kepMappa, path.basename(kepUrl)),
        () => { }
      );
    }

    return res.status(400).send(
      'A válaszüzenet másik beszélgetéshez tartozik.'
    );
  }

  const uzenetSql = `
    INSERT INTO csevegesek
      (aktualis_id, kuldo_id, uzenet, kep_url, valasz_uzenet_id)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.query(
    uzenetSql,
    [
      talalkozasId,
      felhasznaloId,
      encryptText(uzenet),
      kepUrl,
      valasz?.id || null
    ],
    (err, result) => {
      if (err) {
        if (kepUrl) {
          fs.unlink(
            path.join(kepMappa, path.basename(kepUrl)),
            () => { }
          );
        }

        console.error('Üzenet mentési hiba:', err);
        return res.status(500).send('Üzenet mentési hiba');
      }

      const uzenetId = result.insertId;
      void pushErtesites(partnerId, felhasznaloId, talalkozasId);

      const partnerSocket = kliensek.get(String(partnerId));

      if (
        partnerSocket &&
        partnerSocket.readyState === WebSocket.OPEN &&
        felhasznaloTokenAlapjan(
          partnerSocket.munkamenetToken
        ) === Number(partnerId)
      ) {
        partnerSocket.send(JSON.stringify({
          type: 'newMessage',
          talalkozasId,
          partnerId,
          message: {
            id: uzenetId,
            aktualis_id: talalkozasId,
            kuldo_id: felhasznaloId,
            uzenet,
            kep_url: kepUrl,
            valasz_uzenet_id: valasz?.id || null,
            valasz
          }
        }));
      }

      res.json({
        sikeres: true,
        talalkozasId,
        uzenetId,
        kepUrl,
        valasz_uzenet_id: valasz?.id || null,
        valasz
      });
    }
  );
}





// =========================

// KORÁBBI BESZÉLGETÉSEK

// =========================



app.get('/beszelgetesek/:id', vedett, (req, res) => {
  if (Number(req.params.id) !== req.felhasznaloId) return res.status(403).send('Nincs hozzáférés');



  const felhasznaloId =

    req.params.id;





  const sql = `

    SELECT



      t.Id AS talalkozasId,



      CASE

        WHEN t.id_1 = ?

        THEN t.id_2

        ELSE t.id_1

      END AS partnerId,



      s.Felhasznalo AS partnerNev,
      c.visszavont AS utolsoVisszavont,
      s.profilkep_url AS partnerKepUrl,

      c.id AS utolsoUzenetId,
      c.kuldo_id AS utolsoKuldoId,
      c.olvasott AS utolsoOlvasott,
      (SELECT COUNT(*) FROM csevegesek cu WHERE cu.aktualis_id = t.Id
        AND cu.kuldo_id = s.Id AND cu.olvasott = 0) AS olvasatlan,



      CASE WHEN c.kep_url IS NOT NULL THEN 'Kép' ELSE c.uzenet END AS utolsoUzenet,



      t.kezdes



    FROM talalkozas t



    JOIN szemelyek s



      ON s.Id =

        CASE

          WHEN t.id_1 = ?

          THEN t.id_2

          ELSE t.id_1

        END



    LEFT JOIN csevegesek c



      ON c.id = (



        SELECT c2.id



        FROM csevegesek c2



        WHERE c2.aktualis_id = t.Id



        ORDER BY c2.id DESC



        LIMIT 1



      )



    WHERE

      (t.id_1 = ? OR t.id_2 = ?)
      AND NOT EXISTS (SELECT 1 FROM tiltasok b WHERE
        (b.tilto_id = t.id_1 AND b.tiltott_id = t.id_2) OR
        (b.tilto_id = t.id_2 AND b.tiltott_id = t.id_1))



    ORDER BY c.id DESC

  `;





  db.query(

    sql,

    [

      felhasznaloId,

      felhasznaloId,

      felhasznaloId,

      felhasznaloId

    ],

    (err, rows) => {



      if (err) {



        console.error(

          'Beszélgetések lekérési hiba:',

          err

        );



        return res

          .status(500)

          .send('Adatbázis hiba');



      }





      try {
        res.json(rows.map((row) => ({
          ...row,
          utolsoUzenet: Number(row.utolsoVisszavont) === 1
            ? 'Az üzenetet visszavonták'
            : row.utolsoUzenet == null
              ? null
              : decryptText(row.utolsoUzenet)
        })));
      } catch (error) {
        console.error('Üzenet visszafejtési hiba:', error);
        res.status(500).send('Az üzenet nem olvasható');
      }



    }

  );



});


app.post('/profil-szerkesztes', vedett, async (req, res) => {
  const nem = req.body.nem == null || req.body.nem === '' ? null : req.body.nem;
  const lakhely = req.body.lakhely == null ? null : req.body.lakhely;
  const eletkor = req.body.eletkor == null ? null : req.body.eletkor;

  if ((nem !== null && !['Nő', 'Férfi', 'Egyéb'].includes(nem)) ||
    (lakhely !== null && (typeof lakhely !== 'string' || lakhely.length > 100)) ||
    (eletkor !== null &&
      (!Number.isInteger(eletkor) || eletkor < 18 || eletkor > 80)) ||
    (req.body.kepTorles !== undefined &&
      typeof req.body.kepTorles !== 'boolean')) {
    return res.status(400).send('Hibás profiladatok');
  }

  let ujFajl = null;
  let ujKep = null;

  try {
    const letezik = await dbPromise(
      'SELECT Id FROM szemelyek WHERE Id = ?',
      [req.felhasznaloId]
    );
    if (!letezik.length) return res.status(404).send('A fiók nem található');

    if (req.body.profilkepBase64 !== undefined) {
      const adat = req.body.profilkepBase64;

      if (req.body.kepTorles ||
        typeof adat !== 'string' ||
        adat.length > 5600000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(adat)) {
        return res.status(400).send('Érvénytelen vagy túl nagy profilkép');
      }

      const bytes = Buffer.from(adat, 'base64');
      const jpeg = bytes.length >= 4 &&
        bytes.length <= 4 * 1024 * 1024 &&
        bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9;

      if (!jpeg) {
        return res.status(400).send('Legfeljebb 4 MB-os JPEG profilkép küldhető');
      }

      const nev = crypto.randomUUID() + '.jpg';
      ujFajl = path.join(kepMappa, nev);
      fs.writeFileSync(ujFajl, encryptFile(bytes), { flag: 'wx' });
      ujKep = '/feltoltott_kepek/' + nev;
    }

    const kepValtozik = Boolean(ujKep || req.body.kepTorles);
    const sql = kepValtozik
      ? 'UPDATE szemelyek SET nem = ?, lakhely = ?, eletkor = ?, profilkep_url = ? WHERE Id = ?'
      : 'UPDATE szemelyek SET nem = ?, lakhely = ?, eletkor = ? WHERE Id = ?';
    const adatok = kepValtozik
      ? [nem, lakhely ? lakhely.trim() || null : null, eletkor, ujKep, req.felhasznaloId]
      : [nem, lakhely ? lakhely.trim() || null : null, eletkor, req.felhasznaloId];

    await dbPromise(sql, adatok);
    ujFajl = null;

    const profil = await dbPromise(
      'SELECT Id, Felhasznalo, nem, lakhely, eletkor, profilkep_url FROM szemelyek WHERE Id = ?',
      [req.felhasznaloId]
    );
    if (!profil.length) return res.status(404).send('A fiók nem található');
    res.json(profil[0]);
  } catch (error) {
    if (ujFajl) fs.unlink(ujFajl, () => { });
    console.error('Profil szerkesztési hiba:', error);
    res.status(500).send('A profil mentése sikertelen');
  }
});


app.get('/tiltottak', vedett, async (req, res) => {
  try {
    const rows = await dbPromise(
      `SELECT s.Id, s.Felhasznalo, s.profilkep_url
       FROM tiltasok t
       JOIN szemelyek s ON s.Id = t.tiltott_id
       WHERE t.tilto_id = ?
       ORDER BY s.Felhasznalo`,
      [req.felhasznaloId]
    );

    res.json(rows);
  } catch (error) {
    console.error('Letiltottak lekérési hiba:', error);
    res.status(500).send('A tiltott felhasználók lekérése sikertelen');
  }
});

app.get('/partner-beallitasok', vedett, async (req, res) => {
  try {
    const rows = await dbPromise(
      'SELECT kor_min AS korMin, kor_max AS korMax, tavolsag_km AS tavolsagKm FROM partner_keresesi_beallitasok WHERE felhasznalo_id = ?',
      [req.felhasznaloId]
    );
    res.json(rows[0] || { korMin: 18, korMax: 80, tavolsagKm: 50 });
  } catch (error) {
    console.error('Partnerkeresési beállítások lekérési hiba:', error);
    res.status(500).send('A beállítások lekérése sikertelen');
  }
});
app.post('/partner-beallitasok', vedett, async (req, res) => {
  const korMin = Number(req.body.korMin);
  const korMax = Number(req.body.korMax);
  const tavolsagKm = Number(req.body.tavolsagKm);
  if (
    !Number.isInteger(korMin) ||
    !Number.isInteger(korMax) ||
    korMin < 18 ||
    korMax > 80 ||
    korMin > korMax ||
    !Number.isInteger(tavolsagKm) ||
    tavolsagKm < 10 ||
    tavolsagKm > 500
  ) {
    return res.status(400).send('Érvénytelen korhatár vagy távolság');
  }
  try {
    await dbPromise(`INSERT INTO partner_keresesi_beallitasok (felhasznalo_id, kor_min, kor_max, tavolsag_km)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE kor_min = VALUES(kor_min), kor_max = VALUES(kor_max), tavolsag_km = VALUES(tavolsag_km)`,
      [req.felhasznaloId, korMin, korMax, tavolsagKm]);
    res.json({ sikeres: true });
  }
  catch (error) {
    console.error('Partnerkeresési beállítások mentési hiba:', error);
    res.status(500).send('A beállítások mentése sikertelen');
  }
});

app.post('/tiltas-feloldasa', vedett, async (req, res) => {
  const partnerId = Number(req.body.partnerId);

  if (!Number.isInteger(partnerId) || partnerId <= 0 || partnerId === req.felhasznaloId) {
    return res.status(400).send('Hibás felhasználóazonosító');
  }

  try {
    const result = await dbPromise(
      'DELETE FROM tiltasok WHERE tilto_id = ? AND tiltott_id = ?',
      [req.felhasznaloId, partnerId]
    );

    if (!result.affectedRows) {
      return res.status(404).send('Ez a felhasználó nincs letiltva általad');
    }

    res.json({ sikeres: true });
  } catch (error) {
    console.error('Tiltás feloldási hiba:', error);
    res.status(500).send('A tiltás feloldása sikertelen');
  }
});


// =========================

// ÜZENETEK LEKÉRÉSE

// =========================



app.get('/uzenetek/:talalkozasId', vedett, (req, res) => {
  const talalkozasId = req.params.talalkozasId;

  const sql = `
    SELECT
      c.id,
      c.aktualis_id,
      c.kuldo_id,
      c.uzenet,
      c.kep_url,
      c.olvasott,
      c.valasz_uzenet_id,
      v.id AS valaszId,
      v.kuldo_id AS valaszKuldoId,
      v.uzenet AS valaszSzoveg,
      v.kep_url AS valaszKepUrl,
      c.visszavont,
v.visszavont AS valaszVisszavont,
r.emoji AS reakcioEmoji,
r.felhasznalo_id AS reakcioFelhasznaloId
    FROM csevegesek c
    JOIN talalkozas t ON t.Id = c.aktualis_id
    LEFT JOIN csevegesek v
      ON v.id = c.valasz_uzenet_id
      AND v.aktualis_id = c.aktualis_id
    LEFT JOIN uzenet_reakciok r ON r.uzenet_id = c.id
    WHERE c.aktualis_id = ?
      AND (t.id_1 = ? OR t.id_2 = ?)
    ORDER BY c.id ASC
  `;

  db.query(
    sql,
    [talalkozasId, req.felhasznaloId, req.felhasznaloId],
    (err, rows) => {
      if (err) {
        console.error('Üzenetek lekérési hiba:', err);
        return res.status(500).send('Adatbázis hiba');
      }

      try {
        res.json(rows.map(row => {
          const {
            valaszId,
            valaszKuldoId,
            valaszSzoveg,
            valaszKepUrl,
            reakcioEmoji,
            reakcioFelhasznaloId,
            valaszVisszavont,
            ...adat
          } = row;

          return {
            ...adat,
            reakcio: Number(adat.visszavont) === 1 || reakcioEmoji == null
              ? null
              : {
                emoji: reakcioEmoji,
                felhasznaloId: Number(reakcioFelhasznaloId)
              },
            uzenet: Number(adat.visszavont) === 1
              ? ''
              : decryptText(adat.uzenet),
            valasz: valaszId == null || Number(valaszVisszavont) === 1 ? null : {
              id: valaszId,
              kuldo_id: valaszKuldoId,
              uzenet: decryptText(valaszSzoveg).slice(0, 300),
              kep_url: valaszKepUrl,
            }
          };
        }));
      } catch (error) {
        console.error('Üzenet visszafejtési hiba:', error);
        res.status(500).send('Az üzenet nem olvasható');
      }
    }
  );
});





// =========================

// SZERVER INDÍTÁSA

// =========================

app.post('/online-allapot', vedett, async (req, res) => {
  const { kliensId, sorszam, aktiv, partnerIds } = req.body;

  if (typeof kliensId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(kliensId) ||
    !Number.isSafeInteger(sorszam) || sorszam < 1 ||
    typeof aktiv !== 'boolean' ||
    !Array.isArray(partnerIds) || partnerIds.length > 500 ||
    partnerIds.some(id => !Number.isInteger(id) || id <= 0)) {
    return res.status(400).send('Hibás online állapot');
  }

  const kulcs = req.munkamenetToken + ':' + kliensId;
  const elozo = onlineJelenlet.get(kulcs);

  if (!elozo || sorszam > elozo.sorszam) {
    onlineJelenlet.set(kulcs, {
      token: req.munkamenetToken,
      sorszam,
      aktiv,
      frissitve: Date.now()
    });
  }

  try {
    const allapotok = {};
    const ids = [...new Set(partnerIds)];

    ids.forEach(id => { allapotok[id] = false; });

    if (ids.length) {
      const sorok = await dbPromise(`
        SELECT s.Id FROM szemelyek s
        WHERE s.Id IN (?)
          AND NOT EXISTS (
            SELECT 1 FROM tiltasok t
            WHERE (t.tilto_id = ? AND t.tiltott_id = s.Id)
               OR (t.tiltott_id = ? AND t.tilto_id = s.Id)
          )
      `, [ids, req.felhasznaloId, req.felhasznaloId]);

      sorok.forEach(sor => {
        allapotok[sor.Id] = felhasznaloOnline(sor.Id);
      });
    }

    res.json(allapotok);
  } catch (error) {
    console.error('Online állapot lekérési hiba:', error);
    res.status(500).send('Az online állapot lekérése sikertelen');
  }
});

app.post('/uzenet-reakcio', vedett, async (req, res) => {
  const uzenetId = req.body.uzenetId;
  const emoji = req.body.emoji;
  const engedelyezett = ['❤️', '😂', '😮', '😢', '👍'];

  if (!Number.isInteger(uzenetId) || uzenetId <= 0 ||
    (emoji !== null && !engedelyezett.includes(emoji))) {
    return res.status(400).send('Hibás reakció');
  }

  try {
    const sorok = await dbPromise(`
      SELECT c.kuldo_id, c.aktualis_id, t.id_1, t.id_2,c.visszavont
      FROM csevegesek c
      JOIN talalkozas t ON t.Id = c.aktualis_id
      WHERE c.id = ? AND (t.id_1 = ? OR t.id_2 = ?)
      LIMIT 1
    `, [uzenetId, req.felhasznaloId, req.felhasznaloId]);

    if (!sorok.length) {
      return res.status(403).send('Nincs hozzáférés ehhez az üzenethez');
    }

    const uzenet = sorok[0];

    if (Number(uzenet.visszavont) === 1) {
      return res.status(400).send('Visszavont üzenetre nem reagálhatsz');
    }

    if (Number(uzenet.kuldo_id) === req.felhasznaloId) {
      return res.status(403).send('Saját üzenetre nem reagálhatsz');
    }

    const partnerId = Number(uzenet.kuldo_id);

    if (await tiltottPar(req.felhasznaloId, partnerId)) {
      return res.status(403).send('Tiltás miatt nem küldhető reakció');
    }

    if (emoji === null) {
      await dbPromise(
        'DELETE FROM uzenet_reakciok WHERE uzenet_id = ? AND felhasznalo_id = ?',
        [uzenetId, req.felhasznaloId]
      );
    } else {
      await dbPromise(`
  INSERT INTO uzenet_reakciok (uzenet_id, felhasznalo_id, emoji)
  SELECT c.id, ?, ?
  FROM csevegesek c
  WHERE c.id = ? AND c.visszavont = 0
  ON DUPLICATE KEY UPDATE emoji = VALUES(emoji)
`, [req.felhasznaloId, emoji, uzenetId]);
    }

    const aktualis = await dbPromise(
      'SELECT felhasznalo_id, emoji FROM uzenet_reakciok WHERE uzenet_id = ?',
      [uzenetId]
    );

    const reakcio = aktualis.length ? {
      felhasznaloId: Number(aktualis[0].felhasznalo_id),
      emoji: aktualis[0].emoji
    } : null;

    const esemeny = {
      type: 'reaction',
      talalkozasId: uzenet.aktualis_id,
      uzenetId,
      reakcio
    };

    for (const id of [
      Number(uzenet.id_1),
      Number(uzenet.id_2)
    ]) {
      const socket = kliensek.get(String(id));

      if (socket?.readyState === WebSocket.OPEN &&
        felhasznaloTokenAlapjan(socket.munkamenetToken) === id) {
        socket.send(JSON.stringify(esemeny));
      }
    }

    res.json(esemeny);
  } catch (error) {
    console.error('Reakció mentési hiba:', error);
    res.status(500).send('A reakció mentése sikertelen');
  }
});


app.post('/uzenet-visszavonas', vedett, async (req, res) => {
  const uzenetId = req.body.uzenetId;

  if (!Number.isInteger(uzenetId) || uzenetId <= 0) {
    return res.status(400).send('Hibás üzenetazonosító');
  }

  const kapcsolat = mysql.createConnection({
    host: db.config.host,
    port: db.config.port,
    user: db.config.user,
    password: db.config.password,
    database: db.config.database,
    socketPath: db.config.socketPath,
    charset: db.config.charset,
    ssl: db.config.ssl
  });

  const query = (sql, params = []) => new Promise((resolve, reject) => {
    kapcsolat.query(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });

  let adat;
  let kepUrl = null;

  try {
    await query('START TRANSACTION');

    const sorok = await query(`
      SELECT c.kuldo_id, c.aktualis_id, c.kep_url, c.visszavont,
        t.id_1, t.id_2
      FROM csevegesek c
      JOIN talalkozas t ON t.Id = c.aktualis_id
      WHERE c.id = ? AND c.kuldo_id = ?
      FOR UPDATE
    `, [uzenetId, req.felhasznaloId]);

    if (!sorok.length) {
      await query('ROLLBACK');
      return res.status(403).send('Csak a saját üzeneted vonhatod vissza');
    }

    adat = sorok[0];
    kepUrl = adat.kep_url;

    await query(`
      UPDATE csevegesek
      SET visszavont = 1, uzenet = ?, kep_url = NULL
      WHERE id = ? AND kuldo_id = ?
    `, [encryptText(''), uzenetId, req.felhasznaloId]);

    await query(
      'DELETE FROM uzenet_reakciok WHERE uzenet_id = ?',
      [uzenetId]
    );

    await query('COMMIT');
  } catch (error) {
    try { await query('ROLLBACK'); } catch (_) { }
    console.error('Üzenet-visszavonási hiba:', error);
    return res.status(500).send('Az üzenet visszavonása sikertelen');
  } finally {
    kapcsolat.end();
  }

  if (kepUrl && /^\/feltoltott_kepek\/[0-9a-f-]{36}\.(jpg|gif)$/i.test(kepUrl)) {
    fs.unlink(path.join(kepMappa, path.basename(kepUrl)), error => {
      if (error && error.code !== 'ENOENT') {
        console.error('Visszavont kép törlési hiba:', error);
      }
    });
  }

  const esemeny = {
    type: 'messageWithdrawn',
    talalkozasId: adat.aktualis_id,
    uzenetId
  };

  for (const id of [Number(adat.id_1), Number(adat.id_2)]) {
    const socket = kliensek.get(String(id));

    if (socket?.readyState === WebSocket.OPEN &&
      felhasznaloTokenAlapjan(socket.munkamenetToken) === id) {
      try {
        socket.send(JSON.stringify(esemeny));
      } catch (error) {
        console.error('Visszavonási értesítés hiba:', error);
      }
    }
  }

  res.json(esemeny);
});

server.listen(

  3000,

  () => {



    console.log(

      'Szerver fut a 3000-es porton'

    );



    console.log(

      'WebSocket szerver is fut'

    );

  }

);