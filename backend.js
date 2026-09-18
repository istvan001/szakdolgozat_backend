// server.js (vagy app.js)
const express = require('express');
const mysql = require('mysql');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());


const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', 
  database: 'randotalk' 
});


app.get('/szemelyek', (req, res) => {
  const sql = 'SELECT Id,Felhasznalo,Email,Jelszo,Jelentesek FROM szemelyek;';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).send(err);
    res.json(results);
  });
});

app.post('/login', (req, res) => {
  var mysql = require('mysql')
  var connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'randotalk'
  })
  
  connection.connect()

  connection.query("SELECT Id,Felhasznalo,Email,Jelszo,Jelentesek FROM szemelyek WHERE Felhasznalo=? and Jelszo=?;",values=[req.body.Felhasznalo,req.body.Jelszo], function (err, rows, fields) {
    if (err) throw err
    
    res.send(rows)
    console.log("sikerült",req.body)
  })
  connection.end()
});

app.post('/delete', (req, res) => {
  var mysql = require('mysql')
  var connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'randotalk'
  })
  
  connection.connect()

  connection.query("DELETE FROM szemelyek WHERE `szemelyek`.Id = ?;",values=[req.body.Id], function (err, rows, fields) {
    if (err) throw err
    
    res.send(rows)
    console.log("sikerült",req.body)
  })
  connection.end()
});

app.post('/szemelyfelvi', (req, res) => {
  var mysql = require('mysql')
  var connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'randotalk'
  })
  
  connection.connect()

  connection.query("INSERT INTO `szemelyek` (`Id`, `Felhasznalo`, `Jelentesek`, `Email`, `Jelszo`) VALUES (NULL,?, '0', ?, ?);",values=[req.body.Felhasznalo,req.body.Email,req.body.Jelszo], function (err, rows, fields) {
    if (err) throw err
    
    res.send(rows)
    console.log("sikerült",req.body)
  })
  connection.end()
});

app.get('/random/:id', (req, res) => {

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
                (t.id_1 = ? AND t.id_2 = s.Id)
                OR
                (t.id_2 = ? AND t.id_1 = s.Id)
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

                console.error(err);

                return res
                    .status(500)
                    .send('Adatbázis hiba');
            }

            if (rows.length === 0) {

                return res
                    .status(404)
                    .send('Nincs új partner');
            }

            // FONTOS:
            // Itt már NEM hozunk létre talalkozas rekordot!

            res.json({
                partnerId: rows[0].partnerId,
                partnerNev: rows[0].partnerNev
            });

        }
    );
});

app.post('/szemelyfelvi', (req, res) => {
  var mysql = require('mysql')
  var connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'randotalk'
  })
  
  connection.connect()

  connection.query("INSERT INTO `szemelyek` (`Id`, `Felhasznalo`, `Jelentesek`, `Email`, `Jelszo`) VALUES (NULL,?, '0', ?, ?);",values=[req.body.Felhasznalo,req.body.Email,req.body.Jelszo], function (err, rows, fields) {
    if (err) throw err
    
    res.send(rows)
    console.log("sikerült",req.body)
  })
  connection.end()
});

app.post('/uzenet', (req, res) => {

    const felhasznaloId = req.body.felhasznaloId;
    const partnerId = req.body.partnerId;
    const uzenet = req.body.uzenet;

    if (!felhasznaloId || !partnerId || !uzenet) {
        return res.status(400).send('Hiányzó adat');
    }

    // Először megnézzük, van-e már találkozás
    const keresSql = `
        SELECT Id
        FROM talalkozas
        WHERE
            (id_1 = ? AND id_2 = ?)
            OR
            (id_1 = ? AND id_2 = ?)
        LIMIT 1
    `;

    db.query(
        keresSql,
        [felhasznaloId, partnerId, partnerId, felhasznaloId],
        (err, rows) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Adatbázis hiba');
            }

            // Ha még nincs találkozás, létrehozzuk
            if (rows.length === 0) {

    const talalkozasSql = `
        INSERT INTO talalkozas (id_1, id_2, kezdes)
        VALUES (?, ?, NOW())
    `;

    db.query(
        talalkozasSql,
        [felhasznaloId, partnerId],
        (err, result) => {

            if (err) {
                console.error(err);
                return res.status(500).send(
                    'Találkozás létrehozási hiba'
                );
            }

            const talalkozasId = result.insertId;

            // Ezután mentjük az első üzenetet
            const uzenetSql = `
                INSERT INTO csevegesek
                (aktualis_id, kuldo_id, uzenet)
                VALUES (?, ?, ?)
            `;

            db.query(
                uzenetSql,
                [
                    talalkozasId,
                    felhasznaloId,
                    uzenet
                ],
                (err) => {

                    if (err) {
                        console.error(err);
                        return res.status(500).send(
                            'Üzenet mentési hiba'
                        );
                    }

                    res.json({
                        sikeres: true,
                        talalkozasId: talalkozasId
                    });
                }
            );
        }
    );
            } else {

                // Már van találkozás, csak az üzenetet mentjük
                const talalkozasId = rows[0].Id;

                const uzenetSql = `
                    INSERT INTO csevegesek
                    (aktualis_id, kuldo_id, uzenet)
                    VALUES (?, ?, ?)
                `;

                db.query(
                    uzenetSql,
                    [talalkozasId, felhasznaloId, uzenet],
                    (err) => {

                        if (err) {
                            console.error(err);
                            return res.status(500).send('Üzenet mentési hiba');
                        }

                        res.json({
                            sikeres: true,
                            talalkozasId: talalkozasId
                        });
                    }
                );
            }
        }
    );
});

app.get('/beszelgetesek/:id', (req, res) => {

    const felhasznaloId = req.params.id;

    const sql = `
        SELECT
            t.Id AS talalkozasId,
            CASE
                WHEN t.id_1 = ? THEN t.id_2
                ELSE t.id_1
            END AS partnerId,
            s.Felhasznalo AS partnerNev,
            t.kezdes
        FROM talalkozas t
        JOIN szemelyek s
            ON s.Id = CASE
                WHEN t.id_1 = ? THEN t.id_2
                ELSE t.id_1
            END
        WHERE t.id_1 = ?
           OR t.id_2 = ?
        ORDER BY t.kezdes DESC
    `;

    db.query(
        sql,
        [felhasznaloId, felhasznaloId, felhasznaloId, felhasznaloId],
        (err, rows) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Adatbázis hiba');
            }

            res.json(rows);
        }
    );
});

app.get('/uzenetek/:talalkozasId', (req, res) => {

    const talalkozasId = req.params.talalkozasId;

    const sql = `
        SELECT
            id,
            aktualis_id,
            kuldo_id,
            uzenet
        FROM csevegesek
        WHERE aktualis_id = ?
        ORDER BY id ASC
    `;

    db.query(sql, [talalkozasId], (err, rows) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Adatbázis hiba');
        }

        res.json(rows);
    });
});


app.listen(3000, () => {
  console.log('Szerver fut a 3000-es porton');
});
