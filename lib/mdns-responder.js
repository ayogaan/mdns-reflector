const dgram = require('dgram');
const dns = require('dns-packet');
const fs = require('fs').promises;

class GuestResponder {
  constructor() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.pairingsFile = 'data/pairings.json';
    this.devicesFile = 'data/devices.json';
  }

  async start() {
    console.log('🎭 Starting mDNS Responder on vlan20...');
    
    this.socket.bind(5353, '0.0.0.0', () => {
      this.socket.addMembership('224.0.0.251', '192.168.1.104');
      console.log('✅ Listening on 224.0.0.251:5353');
    });

    this.socket.on('message', async (msg, rinfo) => {
      try {
        await this.handleQuery(msg, rinfo);
      } catch (error) {
        console.error('Error:', error.message);
      }
    });
  }

  async handleQuery(msg, rinfo) {
    const packet = dns.decode(msg);
    
    const isGoogleCast = packet.questions?.some(q => 
      q.name === '_googlecast._tcp.local' && q.type === 'PTR'
    );
    
    if (!isGoogleCast) return;
    
    const guestIP = rinfo.address;
    console.log(`\n🔍 Cast query from ${guestIP}`);
    
    const room = await this.getRoomForGuest(guestIP);
    if (!room) {
      console.log(`   ❌ Not paired, ignoring`);
      return;
    }
    
    console.log(`   ✅ Paired to Room ${room}`);
    
    const devices = await this.getDevicesForRoom(room);
    console.log(`   📺 Found ${devices.length} device(s)`);
    
    for (const device of devices) {
      const response = this.buildResponse(device);
      this.socket.send(response, rinfo.port, guestIP);
      console.log(`   ↗️  Sent response for ${device.friendly_name}`);
    }
  }

  async getRoomForGuest(guestIP) {
    try {
      const pairings = JSON.parse(await fs.readFile(this.pairingsFile, 'utf8'));
      const pairing = pairings[guestIP];
      
      if (!pairing) return null;
      if (new Date(pairing.expires_at) < new Date()) return null;
      
      return pairing.room;
    } catch (error) {
      return null;
    }
  }

  async getDevicesForRoom(room) {
    try {
      const devices = JSON.parse(await fs.readFile(this.devicesFile, 'utf8'));
      return devices.filter(d => d.room === room);
    } catch (error) {
      return [];
    }
  }

  buildResponse(device) {
    const instanceName = `Chromecast-${device.uuid.replace(/-/g, '')}`;
    
    return dns.encode({
      type: 'response',
      id: 0,
      flags: 0x8400,
      questions: [],
      answers: [{
        type: 'PTR',
        class: 'IN',
        name: '_googlecast._tcp.local',
        ttl: 120,
        data: `${instanceName}._googlecast._tcp.local`
      }],
      additionals: [
        {
          type: 'TXT',
          class: 'IN',
          name: `${instanceName}._googlecast._tcp.local`,
          ttl: 120,
          data: Buffer.from([
            `id=${device.uuid}`,
            `fn=${device.friendly_name}`,
            'md=Chromecast',
            've=05',
            'ic=/setup/icon.png'
          ].join('\0'))
        },
        {
          type: 'SRV',
          class: 'IN',
          name: `${instanceName}._googlecast._tcp.local`,
          ttl: 120,
          data: {
            priority: 0,
            weight: 0,
            port: 8009,
            target: `${instanceName}.local`
          }
        },
        {
          type: 'A',
          class: 'IN',
          name: `${instanceName}.local`,
          ttl: 120,
          data: device.ip
        }
      ]
    });
  }
}

module.exports = GuestResponder;