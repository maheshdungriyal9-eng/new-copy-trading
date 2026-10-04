const now = new Date();
const istDateStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
const istDate = new Date(istDateStr);

console.log('--- VPS TIME DIAGNOSTICS ---');
console.log('Server Local Time:', now.toString());
console.log('IST Date String:', istDateStr);
console.log('Parsed IST Date:', istDate.toString());
console.log('Parsed Hours:', istDate.getHours());
console.log('Parsed Minutes:', istDate.getMinutes());
console.log('Parsed Day:', istDate.getDay());

// Let's test the calculations
const hours = istDate.getHours();
const minutes = istDate.getMinutes();
const minutesOfDay = hours * 60 + minutes;
console.log('minutesOfDay:', minutesOfDay);
console.log('Market Open NSE (>= 555 and <= 930):', minutesOfDay >= 9 * 60 + 15 && minutesOfDay <= 15 * 60 + 30);
console.log('Market Open Or PreMarket (>= 540 and <= 930):', minutesOfDay >= 9 * 60 && minutesOfDay <= 15 * 60 + 30);
