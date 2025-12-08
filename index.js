// index.js
const ChromecastDiscovery = require('./lib/mdns-listener');

const discovery = new ChromecastDiscovery();

discovery.start().catch(err => {
  console.error('Error starting discovery:', err);
});
