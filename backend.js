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

app.listen(3000, () => {
  console.log('Szerver fut a 3000-es porton');
});
