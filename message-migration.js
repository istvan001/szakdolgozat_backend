// Egyszer futtasd le leállított backend mellett, az adatbázis módosítása után.
// Újrafuttatható: a már titkosított rekordokat és képeket kihagyja.
const mysql = require('mysql');
const fs = require('fs');
const path = require('path');
const { encryptText, encryptFile, isEncryptedFile } = require('./MessageCrypto');
const db = mysql.createConnection({
  host: 'localhost', user: 'root', password: '', database: 'randotalk'
});
const query = (sql, args = []) => new Promise((resolve, reject) =>
  db.query(sql, args, (err, rows) => err ? reject(err) : resolve(rows))
);
async function main() {
  let count = 0;
  while (true) {
    const rows = await query("SELECT id, uzenet FROM csevegesek WHERE uzenet NOT LIKE 'enc:v1:%' ORDER BY id LIMIT 100");
    if (!rows.length) break;
    for (const row of rows) {
      await query('UPDATE csevegesek SET uzenet = ? WHERE id = ? AND uzenet = ?',
        [encryptText(row.uzenet), row.id, row.uzenet]);
      count++;
    }
  }
  const dir = path.join(__dirname, 'feltoltott_kepek');
  let files = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.jpg$/i.test(name)) continue;
      const file = path.join(dir, name);
      const bytes = fs.readFileSync(file);
      if (isEncryptedFile(bytes)) continue;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, encryptFile(bytes), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      files++;
    }
  }
  console.log(`${count} üzenet és ${files} kép titkosítva.`);
}
main().catch((err) => { console.error('Átalakítási hiba:', err); process.exitCode = 1; })
  .finally(() => db.end());