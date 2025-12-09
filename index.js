const ChromecastDiscovery = require('./lib/mdns-listener');
const GuestResponder = require('./lib/mdns-responder');

console.log('🚀 Starting Cast Proxy System');
console.log('==============================\n');

// Phase 1: Discover Chromecasts on VLAN TV
console.log('Phase 1: Device Discovery');
const discovery = new ChromecastDiscovery();
discovery.start().catch(error => {
  console.error('❌ Discovery failed:', error.message);
});

// Phase 3: Respond to guest queries on VLAN Guest
console.log('\nPhase 3: Guest Responder');
const responder = new GuestResponder('192.168.20.1');
responder.start().catch(error => {
  console.error('❌ Responder failed:', error.message);
  process.exit(1);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  responder.stop();
  process.exit(0);
});

console.log('\n✅ All systems operational');
console.log('📝 Press Ctrl+C to stop\n');