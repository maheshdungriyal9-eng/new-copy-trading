const http = require('http');

http.get('http://34.93.162.96:3000', (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    res.resume();
}).on('error', (e) => {
    console.error(`Got error: ${e.message}`);
});
