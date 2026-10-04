const axios = require('axios');
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

async function run() {
  try {
    console.log('Downloading scrip master...');
    const response = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    const rawData = response.data;
    console.log('Downloaded. Total items:', rawData.length);
    
    // Find some NFO instruments
    const nfoItems = rawData.filter(item => item && item.exch_seg === 'NFO');
    console.log('Total NFO items:', nfoItems.length);
    
    // Find NFO items where symbol contains RELIANCE
    const relianceNfo = nfoItems.filter(item => item.symbol && item.symbol.includes('RELIANCE'));
    console.log('Reliance NFO items count:', relianceNfo.length);
    
    if (relianceNfo.length > 0) {
      console.log('First 10 Reliance NFO items:');
      console.log(JSON.stringify(relianceNfo.slice(0, 10), null, 2));
    }
    
    // Find unique names for NFO items that start with RELIANCE or have name like RELIANCE
    const relianceNames = [...new Set(relianceNfo.map(item => item.name))];
    console.log('Unique names for Reliance NFO:', relianceNames);

    // Let's also print some other stock NFO names to see what they look like, e.g. SBIN
    const sbinNfo = nfoItems.filter(item => item.symbol && item.symbol.includes('SBIN'));
    const sbinNames = [...new Set(sbinNfo.map(item => item.name))];
    console.log('Unique names for SBIN NFO:', sbinNames);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
