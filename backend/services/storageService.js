const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDirectory = path.resolve(process.env.COPY_TRADING_DATA_DIR || path.join(__dirname, '..'));

function dataPath(filename) {
  return path.join(dataDirectory, filename);
}

function readJson(filename, fallback) {
  const target = dataPath(filename);
  if (!fs.existsSync(target)) return structuredClone(fallback);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function writeJson(filename, value) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const target = dataPath(filename);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function localSecret(name) {
  const configured = process.env[name];
  if (configured) {
    if (configured.length < 32) throw new Error(`${name} must contain at least 32 characters`);
    return configured;
  }
  const directory = dataPath('.keys');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, name);
  try {
    fs.writeFileSync(target, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return fs.readFileSync(target, 'utf8').trim();
}

module.exports = { dataPath, readJson, writeJson, localSecret };
