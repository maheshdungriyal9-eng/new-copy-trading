const crypto = require('crypto');

// Helper to decode Base32 secret
function decodeBase32(base32Str) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanStr = base32Str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  
  let bits = '';
  let value = 0;
  
  const byteList = [];
  
  for (let i = 0; i < cleanStr.length; i++) {
    const val = base32chars.indexOf(cleanStr.charAt(i));
    if (val === -1) {
      throw new Error('Invalid Base32 character: ' + cleanStr.charAt(i));
    }
    bits += val.toString(2).padStart(5, '0');
  }
  
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    const chunk = bits.substring(i, i + 8);
    byteList.push(parseInt(chunk, 2));
  }
  
  return Buffer.from(byteList);
}

// Generate 6-digit TOTP
function generateTOTP(secret, customTime = null) {
  try {
    const key = decodeBase32(secret);
    
    // Calculate 30-second interval counter
    const timeMs = customTime !== null ? customTime : Date.now();
    const epoch = Math.floor(timeMs / 1000);
    const counter = Math.floor(epoch / 30);
    
    // Convert counter to 8-byte buffer
    const buffer = Buffer.alloc(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
      buffer[i] = tmp & 0xff;
      tmp = tmp >> 8;
    }
    
    // Hash the counter buffer with the key using HMAC-SHA1
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(buffer);
    const hmacResult = hmac.digest();
    
    // Dynamic truncation
    const offset = hmacResult[hmacResult.length - 1] & 0xf;
    const code = 
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);
      
    const otp = code % 1000000;
    return otp.toString().padStart(6, '0');
  } catch (error) {
    console.error('Error generating TOTP:', error.message);
    return '000000';
  }
}

module.exports = {
  generateTOTP
};
