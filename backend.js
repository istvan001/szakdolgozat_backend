const express = require('express');

const mysql = require('mysql');

const cors = require('cors');

const http = require('http');

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptText, decryptText, encryptFile, decryptFile } = require('./messageCrypto');



const app = express();



app.use(cors());

// A képek JPEG formátumban, legfeljebb 4 MB méretben érkezhetnek.
app.use(express.json({ limit: '6mb' }));
const kepMappa = path.join(__dirname, 'feltoltott_kepek');
fs.mkdirSync(kepMappa, { recursive: true });

const munkamenetek = new Map();
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
  if (!/^[0-9a-f-]{36}\.jpg$/i.test(nev)) return res.status(404).end();
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
        res.type('jpg').send(decryptFile(bytes));
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

  database: 'randotalk'

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





  ws.on('message', (message) => {



    try {



      const data = JSON.parse(message.toString());





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
  db.query('SELECT Id, Felhasznalo, Jelszo FROM szemelyek WHERE Felhasznalo = ?', [nev],
    (err, rows) => {
      if (err) return res.status(500).send('Adatbázis hiba');
      const felhasznalo = rows.find((row) => jelszoHelyes(jelszo, row.Jelszo));
      if (!felhasznalo) return res.status(401).send('Hibás felhasználónév vagy jelszó');
      const token = crypto.randomBytes(32).toString('hex');
      munkamenetek.set(token, { id: Number(felhasznalo.Id), lejarat: Date.now() + TOKEN_ELETTARTAM });
      if (!felhasznalo.Jelszo.startsWith('scrypt$')) {
        db.query('UPDATE szemelyek SET Jelszo = ? WHERE Id = ?',
          [jelszoHash(jelszo), felhasznalo.Id], (hiba) => {
            if (hiba) console.error('Régi jelszó migrációs hiba:', hiba);
          });
      }
      res.json({ token, felhasznaloId: felhasznalo.Id, felhasznaloNev: felhasznalo.Felhasznalo });
    }
  );
});

app.post('/logout', vedett, (req, res) => {
  munkamenetek.delete(req.munkamenetToken);
  const ws = kliensek.get(String(req.felhasznaloId));
  if (ws && ws.munkamenetToken === req.munkamenetToken) ws.close(1008, 'Kijelentkezés');
  res.json({ sikeres: true });
});


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



app.post('/szemelyfelvi', (req, res) => {
  const Felhasznalo = String(req.body.Felhasznalo || '').trim();
  const Email = String(req.body.Email || '').trim();
  const Jelszo = String(req.body.Jelszo || '');
  const nem = req.body.nem || null;
  const lakhely = req.body.lakhely ? String(req.body.lakhely).trim() : null;
  const eletkor = req.body.eletkor == null ? null : Number(req.body.eletkor);
  const profilkepBase64 = req.body.profilkepBase64;

  if (!Felhasznalo || !Email || !Jelszo || Felhasznalo.length > 100 ||
      Email.length > 200 || Jelszo.length > 100 ||
      (lakhely && lakhely.length > 100) ||
      (nem && !['Nő', 'Férfi', 'Egyéb'].includes(nem)) ||
      (eletkor !== null && (!Number.isInteger(eletkor) || eletkor < 18 || eletkor > 80))) {
    return res.status(400).send('Hiányzó vagy hibás regisztrációs adat');
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
    (Felhasznalo, Jelentesek, Email, Jelszo, nem, lakhely, eletkor, profilkep_url)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?)`;
  db.query(sql, [Felhasznalo, Email, jelszoHash(Jelszo), nem, lakhely, eletkor, profilkepUrl],
    (err, result) => {
      if (err) {
        if (profilkepFajl) fs.unlink(profilkepFajl, () => {});
        console.error('Regisztrációs hiba:', err);
        return res.status(500).send('Nem sikerült regisztrálni');
      }
      res.json({ sikeres: true, felhasznaloId: result.insertId });
    }
  );
});

app.get('/profil/:id', vedett, (req, res) => {
  db.query(
    `SELECT Id, Felhasznalo, nem, lakhely, eletkor, profilkep_url
     FROM szemelyek WHERE Id = ? LIMIT 1`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).send('Adatbázis hiba');
      if (!rows.length) return res.status(404).send('Nincs ilyen felhasználó');
      res.json(rows[0]);
    }
  );
});


// =========================

// RANDOM PARTNER KERESÉSE

// =========================



app.get('/random/:id', vedett, (req, res) => {
  if (Number(req.params.id) !== req.felhasznaloId) return res.status(403).send('Nincs hozzáférés');



  const felhasznaloId = req.params.id;



  const sql = `

    SELECT

      s.Id AS partnerId,

      s.Felhasznalo AS partnerNev



    FROM szemelyek s



    WHERE s.Id != ?



    AND NOT EXISTS (



      SELECT 1

      FROM talalkozas t



      WHERE

        (

          t.id_1 = ?

          AND

          t.id_2 = s.Id

        )



        OR



        (

          t.id_2 = ?

          AND

          t.id_1 = s.Id

        )



    )



    ORDER BY RAND()



    LIMIT 1

  `;





  db.query(

    sql,

    [

      felhasznaloId,

      felhasznaloId,

      felhasznaloId

    ],

    (err, rows) => {



      if (err) {



        console.error(

          'Partner keresési hiba:',

          err

        );



        return res

          .status(500)

          .send('Adatbázis hiba');

      }





      if (rows.length === 0) {



        return res

          .status(404)

          .send('Nincs új partner');

      }





      res.json({



        partnerId: rows[0].partnerId,



        partnerNev: rows[0].partnerNev



      });



    }

  );



});





// =========================

// ÜZENET KÜLDÉSE

// =========================



app.post('/uzenet', vedett, (req, res) => {



  const felhasznaloId = req.felhasznaloId;



  const partnerId = Number(req.body.partnerId);
  if (!Number.isInteger(partnerId) || partnerId <= 0 || partnerId === felhasznaloId) {
    return res.status(400).send('Hibás partner');
  }



  const uzenet = typeof req.body.uzenet === 'string' ? req.body.uzenet.trim() : '';
  const kepBase64 = req.body.kepBase64;
  let kepUrl = null;
  if (kepBase64 !== undefined) {
    if (typeof kepBase64 !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(kepBase64) ||
        kepBase64.length > 5600000) {
      return res.status(400).send('Érvénytelen vagy túl nagy kép');
    }
    const bytes = Buffer.from(kepBase64, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || bytes.length < 4 ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      return res.status(400).send('Legfeljebb 4 MB-os JPEG kép küldhető');
    }
    const nev = crypto.randomUUID() + '.jpg';
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
              res

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
          res

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
  res

) {



  const uzenetSql = `

    INSERT INTO csevegesek

    (

      aktualis_id,

      kuldo_id,

      uzenet,
      kep_url

    )

    VALUES

    (

      ?,

      ?,

      ?,
      ?

    )

  `;





  db.query(

    uzenetSql,

    [

      talalkozasId,

      felhasznaloId,

      encryptText(uzenet),
      kepUrl

    ],

    (err, result) => {



      if (err) {



        console.error(

          'Üzenet mentési hiba:',

          err

        );



        return res

          .status(500)

          .send('Üzenet mentési hiba');



      }





      const uzenetId =

        result.insertId;





      // =========================

      // WEBSOCKET ÉRTESÍTÉS

      // =========================



      const partnerSocket =

        kliensek.get(String(partnerId));





      if (

        partnerSocket &&

        partnerSocket.readyState === WebSocket.OPEN &&
        felhasznaloTokenAlapjan(partnerSocket.munkamenetToken) === Number(partnerId)

      ) {



        partnerSocket.send(

          JSON.stringify({



            type: 'newMessage',



            talalkozasId: talalkozasId,



            partnerId: partnerId,



            message: {



              id: uzenetId,



              aktualis_id: talalkozasId,



              kuldo_id: felhasznaloId,



              uzenet: uzenet,
              kep_url: kepUrl



            }



          })

        );





        console.log(

          'WebSocket üzenet elküldve:',

          partnerId

        );



      }





      res.json({



        sikeres: true,



        talalkozasId: talalkozasId,



        uzenetId: uzenetId,
        kepUrl: kepUrl



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

      s.profilkep_url AS partnerKepUrl,



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

      t.id_1 = ?

      OR

      t.id_2 = ?



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
          utolsoUzenet: row.utolsoUzenet == null ? null : decryptText(row.utolsoUzenet)
        })));
      } catch (error) {
        console.error('Üzenet visszafejtési hiba:', error);
        res.status(500).send('Az üzenet nem olvasható');
      }



    }

  );



});





// =========================

// ÜZENETEK LEKÉRÉSE

// =========================



app.get('/uzenetek/:talalkozasId', vedett, (req, res) => {



  const talalkozasId =

    req.params.talalkozasId;





  const sql = `

    SELECT c.id, c.aktualis_id, c.kuldo_id, c.uzenet, c.kep_url

    FROM csevegesek c



    JOIN talalkozas t ON t.Id = c.aktualis_id
    WHERE c.aktualis_id = ? AND (t.id_1 = ? OR t.id_2 = ?)



    ORDER BY c.id ASC

  `;





  db.query(

    sql,

    [talalkozasId, req.felhasznaloId, req.felhasznaloId],

    (err, rows) => {



      if (err) {



        console.error(

          'Üzenetek lekérési hiba:',

          err

        );



        return res

          .status(500)

          .send('Adatbázis hiba');



      }





      try {
        res.json(rows.map((row) => ({ ...row, uzenet: decryptText(row.uzenet) })));
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