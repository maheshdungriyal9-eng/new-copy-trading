const crypto = require('crypto');
const { localSecret } = require('./storageService');

function key(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

class CryptoService {
  encrypt(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw new Error('Credentials must be strings');
    if (value.startsWith('gcm:')) return value;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(localSecret('ENCRYPTION_KEY')), nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['gcm', nonce.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
  }

  decrypt(value) {
    if (!value) return '';
    if (typeof value !== 'string') throw new Error('Invalid encrypted credential');
    if (value.startsWith('gcm:')) {
      const [, nonce, tag, payload] = value.split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key(localSecret('ENCRYPTION_KEY')), Buffer.from(nonce, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(payload, 'hex')), decipher.final()]).toString('utf8');
    }
    if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(value)) {
      if (!process.env.LEGACY_ENCRYPTION_KEY) throw new Error('Set LEGACY_ENCRYPTION_KEY to migrate existing CBC credentials');
      const [nonce, payload] = value.split(':');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key(process.env.LEGACY_ENCRYPTION_KEY), Buffer.from(nonce, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(payload, 'hex')), decipher.final()]).toString('utf8');
    }
    return value;
  }
}

module.exports = new CryptoService();
