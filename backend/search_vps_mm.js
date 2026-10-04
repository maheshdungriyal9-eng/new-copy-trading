const fs = require('fs');
const path = require('path');
const instrumentService = require('./services/instrumentService');

async function check() {
  await instrumentService.initializeInstruments();
  const db = instrumentService.getDatabase();
  
  // Find instruments starting with M or containing M&M
  const matches = db.filter(item => 
    item.symbol.includes('M&M') || 
    item.symbol.includes('M_M') ||
    item.name.includes('MAHINDRA')
  );
  
  console.log('Total matches found:', matches.length);
  console.log(JSON.stringify(matches, null, 2));
}

check();
