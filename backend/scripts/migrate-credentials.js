const config = require('../services/configService');
config.saveConfig(config.loadConfig());
console.log('Credentials re-encrypted using the current installation key.');
