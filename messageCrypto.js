const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const keyPath = path.join(__dirname, '.randotalk-encryption-key');
if (!fs.existsSync(keyPath)) {
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const key = fs.readFileSync(keyPath);
if (key.length !== 32) throw new Error('Hibás titkosítási kulcs');
const prefix = 'enc:v1:';
const filePrefix = Buffer.from('RDT1');

function encryptBytes(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), encrypted };
}
function decryptBytes(iv, tag, encrypted) {
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Hibás titkosított adat');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
function encryptText(value) {
  const { iv, tag, encrypted } = encryptBytes(Buffer.from(value, 'utf8'));
  return prefix + [iv, tag, encrypted].map((part) => part.toString('base64')).join(':');
}
function decryptText(value) {
  if (!value.startsWith(prefix)) return value; // korábbi rekord az átalakításig
  const parts = value.slice(prefix.length).split(':');
  if (parts.length !== 3) throw new Error('Hibás titkosított üzenet');
  return decryptBytes(...parts.map((part) => Buffer.from(part, 'base64'))).toString('utf8');
}
function encryptFile(bytes) {
  const { iv, tag, encrypted } = encryptBytes(bytes);
  return Buffer.concat([filePrefix, iv, tag, encrypted]);
}
function decryptFile(bytes) {
  if (!bytes.subarray(0, 4).equals(filePrefix)) return bytes; // korábbi kép az átalakításig
  if (bytes.length < 32) throw new Error('Hibás titkosított kép');
  return decryptBytes(bytes.subarray(4, 16), bytes.subarray(16, 32), bytes.subarray(32));
}
function isEncryptedFile(bytes) {
  return bytes.subarray(0, 4).equals(filePrefix);
}
module.exports = { encryptText, decryptText, encryptFile, decryptFile, isEncryptedFile };