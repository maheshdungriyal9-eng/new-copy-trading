const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

async function testFilter() {
  try {
    console.log('Downloading master list...');
    const response = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    const rawData = response.data;
    console.log('Total raw instruments:', rawData.length);
    
    const activeFoTickers = new Set();
    rawData.forEach(item => {
      if (item && (item.exch_seg === 'NFO' || item.exch_seg === 'BFO') && item.name) {
        activeFoTickers.add(item.name.toUpperCase().trim());
      }
    });
    console.log('Total F&O tickers found:', activeFoTickers.size);
    
    const filtered = rawData.filter(item => {
      if (!item || !item.symbol) return false;
      if (item.exch_seg === 'NSE' && item.symbol.endsWith('-EQ')) return true;
      if (item.exch_seg === 'MCX') return true;
      if ((item.exch_seg === 'NFO' || item.exch_seg === 'BFO') && activeFoTickers.has(item.name)) return true;
      return false;
    });
    
    console.log('Total filtered instruments:', filtered.length);
    
    // Check for BAJAJ-AUTO option or future in filtered list
    const bajajMatches = filtered.filter(i => i.symbol && i.symbol.includes('BAJAJ-AUTO'));
    console.log('BAJAJ-AUTO matches in filtered list:', bajajMatches.length);
    if (bajajMatches.length > 0) {
      console.log('Sample matches:');
      console.log(bajajMatches.slice(0, 5));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testFilter();
