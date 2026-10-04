try {
  console.log('Verifying copyTradingEngine.js syntax...');
  require('./services/copyTradingEngine');
  console.log('Syntax check passed! copyTradingEngine.js required successfully.');
} catch (e) {
  console.error('Syntax check failed:', e);
  process.exit(1);
}
