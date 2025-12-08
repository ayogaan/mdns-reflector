# Cast Proxy Implementation Guide
## Fedora Router + Node.js + Text-based Storage

**Mentor Session Summary**  
**Date**: December 8, 2025  
**Student Tech Stack**: Fedora Router, Node.js, Text Files (JSON)

---

## Table of Contents

1. [Understanding Castaway](#understanding-castaway)
2. [Your Architecture](#your-architecture)
3. [Phase 1: Device Discovery](#phase-1-device-discovery)
4. [Phase 2: Pairing System](#phase-2-pairing-system)
5. [Phase 3: mDNS Spoofing](#phase-3-mdns-spoofing)
6. [Phase 4: Firewall Integration](#phase-4-firewall-integration)
7. [Testing Guide](#testing-guide)
8. [Troubleshooting](#troubleshooting)

---

## Understanding Castaway

### What is Castaway?

Castaway is a Python proof-of-concept that solves **Chromecast discovery across different subnets** by:

1. **Intercepting** mDNS queries from guest devices asking for `_googlecast._tcp.local`
2. **Fetching** Chromecast info from `http://<chromecast_ip>:8008/ssdp/device-desc.xml`
3. **Spoofing** mDNS responses with complete device information (TXT, SRV, A records)

### Key Insights from Castaway

**Why Cross-Subnet Casting Fails:**
- mDNS uses multicast (224.0.0.251:5353) which doesn't route
- TTL is set to 1 (packets die at first router)
- Chromecasts refuse to respond to queries from different subnets

**The Solution:**
Don't forward mDNS - instead, act as a **proxy** that:
- Listens to both VLANs
- Builds a registry of Chromecasts
- Selectively responds based on authorization

---

## Your Architecture

### Network Topology

```
Internet
   │
   ├─ Fedora Router (Cast Proxy runs HERE)
   │     ├─ vlan20 (Guest): 192.168.20.1/24
   │     └─ vlan30 (TV):    192.168.30.1/24
   │
   ├─ Access Point (dumb WiFi bridge)
   │     └─ VLAN 20 tagged
   │
   ├─ Guest Devices (VLAN 20)
   └─ Chromecasts/TVs (VLAN 30)
```

### Components

```
/opt/cast-proxy/
├── index.js              # Main entry
├── config.json
├── package.json
│
├── lib/
│   ├── mdns-listener.js   # Discover Chromecasts (VLAN TV)
│   ├── mdns-responder.js  # Answer queries (VLAN Guest)
│   ├── policy.js          # Check permissions
│   ├── firewall.js        # Manage nftables
│   └── device-info.js     # Fetch Chromecast XML
│
├── api/
│   ├── server.js          # Express HTTP server
│   ├── pairing.js         # QR codes, pairing flow
│   └── internal.js        # TV app endpoints
│
├── data/
│   ├── rooms.json         # Room definitions
│   ├── devices.json       # Chromecast registry
│   ├── pairings.json      # Guest ↔ Room mappings
│   └── sessions.log       # Cast logs
│
└── tv-app/
    └── qr-display.html    # TV interface
```

### Data Structures

**devices.json**
```json
[
  {
    "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "friendly_name": "Living Room TV",
    "ip": "192.168.30.101",
    "room": "101",
    "last_seen": "2025-12-08T14:30:45.123Z"
  }
]
```

**pairings.json**
```json
{
  "192.168.20.105": {
    "room": "101",
    "paired_at": "2025-12-08T10:30:00Z",
    "expires_at": "2025-12-08T22:00:00Z"
  }
}
```

---

## Phase 1: Device Discovery

### Goal
Automatically discover all Chromecasts on VLAN TV and save to `devices.json`

### Implementation

**lib/mdns-listener.js**
```javascript
const mdns = require('mdns');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;

class ChromecastDiscovery {
  constructor() {
    this.devicesFile = 'data/devices.json';
  }

  async start() {
    console.log('🚀 Starting Chromecast Discovery...');
    
    const browser = mdns.createBrowser(mdns.tcp('googlecast'), {
      networkInterface: '192.168.30.1'
    });

    browser.on('serviceUp', async (service) => {
      const ip = service.addresses[0];
      console.log(`\n📡 Found Chromecast at ${ip}`);
      
      try {
        const deviceInfo = await this.fetchDeviceInfo(ip);
        await this.saveDevice(deviceInfo);
        console.log(`✅ Saved: ${deviceInfo.friendly_name}`);
      } catch (error) {
        console.error(`❌ Error processing ${ip}:`, error.message);
      }
    });

    browser.start();
  }

  async fetchDeviceInfo(ip) {
    const response = await axios.get(`http://${ip}:8008/ssdp/device-desc.xml`);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);
    const device = result.root.device[0];
    
    return {
      uuid: device.UDN[0].replace('uuid:', ''),
      friendly_name: device.friendlyName[0],
      ip: ip,
      last_seen: new Date().toISOString(),
      room: null
    };
  }

  async saveDevice(deviceInfo) {
    let devices = [];
    try {
      const data = await fs.readFile(this.devicesFile, 'utf8');
      devices = JSON.parse(data);
    } catch (error) {}
    
    const index = devices.findIndex(d => d.uuid === deviceInfo.uuid);
    if (index >= 0) {
      devices[index] = { ...devices[index], ...deviceInfo };
    } else {
      devices.push(deviceInfo);
    }
    
    await fs.writeFile(this.devicesFile, JSON.stringify(devices, null, 2));
  }
}

module.exports = ChromecastDiscovery;
```

### Testing Phase 1

**Test 1: Manual Device Info**
```bash
npm install axios xml2js
node -e "
const axios = require('axios');
axios.get('http://192.168.30.101:8008/ssdp/device-desc.xml')
  .then(r => console.log(r.data))
  .catch(e => console.error(e.message));
"
```

**Test 2: mDNS Discovery**
```bash
npm install mdns
sudo node lib/mdns-listener.js
```

**Expected Output:**
```
🚀 Starting Chromecast Discovery...
📡 Found Chromecast at 192.168.30.101
✅ Saved: Living Room TV
```

**Test 3: Verify JSON**
```bash
cat data/devices.json
```

**Test 4: Assign Rooms**
Edit `devices.json` and add `"room": "101"` manually

---

## Phase 2: Pairing System

### Goal
Generate QR codes on TV, allow guests to scan and pair

### Implementation

**api/server.js**
```javascript
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs').promises;

const app = express();
app.use(express.json());
app.use('/tv-app', express.static('tv-app'));

const tokensFile = 'data/tokens.json';
const pairingsFile = 'data/pairings.json';

// Generate pairing token for TV
app.post('/api/rooms/:room/pairing-token', async (req, res) => {
  const room = req.params.room;
  const token = crypto.randomBytes(16).toString('hex');
  
  let tokens = {};
  try {
    tokens = JSON.parse(await fs.readFile(tokensFile, 'utf8'));
  } catch (e) {}
  
  tokens[token] = {
    room: room,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };
  
  await fs.writeFile(tokensFile, JSON.stringify(tokens, null, 2));
  
  const pairingURL = `http://192.168.20.1:3000/pair?token=${token}`;
  const qrImage = await QRCode.toDataURL(pairingURL);
  
  res.json({
    room: room,
    pairing_url: pairingURL,
    qr_image: qrImage,
    expires_at: tokens[token].expires_at
  });
});

// Guest pairing endpoint
app.get('/pair', async (req, res) => {
  const token = req.query.token;
  const guestIP = req.ip || req.connection.remoteAddress;
  
  console.log(`\n📱 Pairing request from ${guestIP} with token ${token}`);
  
  let tokens = {};
  try {
    tokens = JSON.parse(await fs.readFile(tokensFile, 'utf8'));
  } catch (e) {
    return res.status(500).send('Server error');
  }
  
  const tokenData = tokens[token];
  if (!tokenData) {
    return res.status(400).send('❌ Invalid token');
  }
  
  if (new Date(tokenData.expires_at) < new Date()) {
    return res.status(400).send('❌ Token expired');
  }
  
  let pairings = {};
  try {
    pairings = JSON.parse(await fs.readFile(pairingsFile, 'utf8'));
  } catch (e) {}
  
  pairings[guestIP] = {
    room: tokenData.room,
    paired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    token_used: token
  };
  
  await fs.writeFile(pairingsFile, JSON.stringify(pairings, null, 2));
  
  console.log(`✅ Paired ${guestIP} → Room ${tokenData.room}`);
  
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
            font-family: Arial, sans-serif;
            padding: 50px 20px;
          }
          h1 { font-size: 48px; margin: 20px 0; }
          .success { font-size: 72px; margin: 30px 0; }
        </style>
      </head>
      <body>
        <div class="success">✅</div>
        <h1>Pairing Successful!</h1>
        <p>You can now cast to TV in <strong>Room ${tokenData.room}</strong></p>
        <p>Open YouTube, Netflix, or any Cast app</p>
      </body>
    </html>
  `);
});

app.listen(3000, '0.0.0.0', () => {
  console.log('✅ API server running on http://0.0.0.0:3000');
});
```

**tv-app/room101.html**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Room 101 - Cast Pairing</title>
  <style>
    body {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      text-align: center;
      font-family: Arial, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      margin: 0;
    }
    h1 { font-size: 72px; margin: 20px; }
    p { font-size: 36px; margin: 20px; }
    #qr { 
      background: white; 
      padding: 40px; 
      border-radius: 20px;
      box-shadow: 0 10px 50px rgba(0,0,0,0.3);
    }
  </style>
</head>
<body>
  <h1>Room <span id="room">101</span></h1>
  <p>📱 Scan to Cast</p>
  <img id="qr" width="400" height="400" />
  <p id="status">Loading...</p>
  
  <script>
    const ROOM = '101';
    const API_URL = 'http://192.168.30.1:3000/api/rooms/' + ROOM + '/pairing-token';
    
    async function refreshQR() {
      try {
        const res = await fetch(API_URL, { method: 'POST' });
        const data = await res.json();
        
        document.getElementById('room').textContent = data.room;
        document.getElementById('qr').src = data.qr_image;
        document.getElementById('status').textContent = 
          `✅ Valid until ${new Date(data.expires_at).toLocaleTimeString()}`;
      } catch (error) {
        document.getElementById('status').textContent = '❌ Error loading QR';
      }
    }
    
    refreshQR();
    setInterval(refreshQR, 15 * 60 * 1000);
  </script>
</body>
</html>
```

### Testing Phase 2

**Test 1: Generate Token**
```bash
npm install express qrcode
node api/server.js &
curl -X POST http://192.168.20.1:3000/api/rooms/101/pairing-token
```

**Test 2: View QR on TV**
Open browser: `http://192.168.30.1:3000/tv-app/room101.html`

**Test 3: Guest Pairing**
On phone connected to Guest WiFi:
- Scan QR code
- Should open pairing page
- Check `data/pairings.json`

---

## Phase 3: mDNS Spoofing

### Goal
Guest apps (YouTube/Netflix) discover ONLY their room's Chromecast

### Implementation

**lib/mdns-responder.js**
```javascript
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
      this.socket.addMembership('224.0.0.251', '192.168.20.1');
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
```

### Testing Phase 3

**Test 1: Listen for Queries**
```bash
sudo tcpdump -i vlan20 port 5353 -v
# Open YouTube on guest phone, press Cast button
```

**Test 2: Run Responder**
```bash
npm install dns-packet
sudo node lib/mdns-responder.js
```

**Test 3: End-to-End**
1. Pair phone to Room 101
2. Open YouTube app
3. Press Cast button
4. Should see Room 101's TV only

---

## Phase 4: Firewall Integration

### Goal
Block direct connections to Chromecasts unless paired

### Implementation

**nftables config: /etc/nftables/cast-isolation.nft**
```nft
table inet filter {
  set cast_allowed_pairs {
    type ipv4_addr . ipv4_addr
    flags timeout
    timeout 15m
  }
  
  chain forward {
    # Block mDNS between VLANs
    ip saddr 192.168.20.0/24 ip daddr 192.168.30.0/24 udp dport 5353 drop
    
    # Allow paired connections
    ip saddr . ip daddr @cast_allowed_pairs accept
    
    # Default: block Guest → TV
    ip saddr 192.168.20.0/24 ip daddr 192.168.30.0/24 drop
    
    accept
  }
}
```

**lib/firewall.js**
```javascript
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class FirewallManager {
  async allowPair(guestIP, chromecastIP, ttlMinutes = 15) {
    const pair = `${guestIP} . ${chromecastIP}`;
    
    try {
      await execPromise(`
        nft add element inet filter cast_allowed_pairs { ${pair} timeout ${ttlMinutes}m }
      `);
      
      console.log(`🔓 Allowed ${guestIP} → ${chromecastIP} for ${ttlMinutes}m`);
      return true;
    } catch (error) {
      console.error(`❌ Firewall error:`, error.message);
      return false;
    }
  }

  async revokePair(guestIP, chromecastIP) {
    const pair = `${guestIP} . ${chromecastIP}`;
    
    try {
      await execPromise(`
        nft delete element inet filter cast_allowed_pairs { ${pair} }
      `);
      
      console.log(`🔒 Revoked ${guestIP} → ${chromecastIP}`);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = FirewallManager;
```

**Integrate into mdns-responder.js:**
```javascript
const FirewallManager = require('./firewall');

class GuestResponder {
  constructor() {
    // ... existing code ...
    this.firewall = new FirewallManager();
  }

  async handleQuery(msg, rinfo) {
    // ... existing code ...
    
    for (const device of devices) {
      const response = this.buildResponse(device);
      this.socket.send(response, rinfo.port, guestIP);
      
      // Open firewall
      await this.firewall.allowPair(guestIP, device.ip, 15);
    }
  }
}
```

### Testing Phase 4

**Test 1: Load Firewall**
```bash
sudo nft -f /etc/nftables/cast-isolation.nft
sudo nft list ruleset
```

**Test 2: Verify Blocking**
```bash
# From guest device (unpaired)
curl http://192.168.30.101:8009/setup/eureka_info
# Expected: Timeout
```

**Test 3: Paired Connection**
1. Pair phone to Room 101
2. Open YouTube, press Cast
3. Connection should work
4. Check firewall:
```bash
sudo nft list set inet filter cast_allowed_pairs
```

---

## Testing Guide

### Quick Test Checklist

**Phase 1 Complete:**
- [ ] `devices.json` has Chromecasts
- [ ] Timestamps update automatically
- [ ] Rooms manually assigned

**Phase 2 Complete:**
- [ ] QR code displays on TV
- [ ] Phone scans QR successfully
- [ ] `pairings.json` shows guest IP

**Phase 3 Complete:**
- [ ] YouTube finds Chromecast
- [ ] Can cast video successfully
- [ ] Unpaired guests see nothing

**Phase 4 Complete:**
- [ ] Firewall blocks unpaired guests
- [ ] Paired guests can connect
- [ ] Rules auto-expire

### Integration Test Script

```javascript
// test/integration-test.js
const axios = require('axios');
const fs = require('fs');

async function test() {
  console.log('🧪 Running Integration Tests\n');
  
  // Test 1: Devices
  const devices = JSON.parse(fs.readFileSync('data/devices.json'));
  console.assert(devices.length > 0, 'No devices!');
  console.log(`✅ Test 1: ${devices.length} device(s) found`);
  
  // Test 2: Pairing
  const res = await axios.post('http://192.168.20.1:3000/api/rooms/101/pairing-token');
  console.assert(res.data.room === '101', 'Wrong room!');
  console.log(`✅ Test 2: Pairing token generated`);
  
  // Test 3: Firewall
  const { exec } = require('child_process');
  exec('nft list set inet filter cast_allowed_pairs', (err, stdout) => {
    console.log(err ? '❌ Test 3: Firewall not loaded' : '✅ Test 3: Firewall active');
  });
}

test().catch(console.error);
```

---

## Troubleshooting

| Problem | Test Command | Solution |
|---------|-------------|----------|
| No Chromecasts found | `sudo tcpdump -i vlan30 port 5353` | Check VLAN config, allow mDNS in firewall |
| QR doesn't load | `curl localhost:3000/api/rooms/101/pairing-token` | Check Node.js server running |
| YouTube doesn't see TV | `sudo tcpdump -i vlan20 port 5353` | Check responder running, pairing exists |
| Can't cast video | `curl http://192.168.30.101:8009/setup/eureka_info` | Check firewall opened connection |
| Firewall not working | `sudo nft list ruleset` | Check nftables loaded correctly |

---

## Installation Steps

```bash
# 1. Install Node.js
sudo dnf install nodejs npm

# 2. Create project
sudo mkdir -p /opt/cast-proxy/{lib,api,data,tv-app}
cd /opt/cast-proxy

# 3. Install dependencies
npm install mdns axios xml2js express qrcode dns-packet

# 4. Configure VLANs
sudo nmcli connection add type vlan ifname vlan20 dev eth0 id 20 ip4 192.168.20.1/24
sudo nmcli connection add type vlan ifname vlan30 dev eth0 id 30 ip4 192.168.30.1/24

# 5. Enable forwarding
echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 6. Load firewall
sudo nft -f /etc/nftables/cast-isolation.nft

# 7. Create systemd service
sudo tee /etc/systemd/system/cast-proxy.service << 'EOF'
[Unit]
Description=Cast Proxy for Hotel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/cast-proxy
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# 8. Enable and start
sudo systemctl enable --now cast-proxy
```

---

## Next Steps

1. **This Week**: Implement Phase 1 (device discovery)
2. **Next Week**: Build pairing system (Phase 2)
3. **Week 3**: mDNS spoofing (Phase 3)
4. **Week 4**: Firewall integration (Phase 4)

---

## Additional Resources

- **Castaway GitHub**: https://github.com/KoalaTea/castaway
- **mDNS RFC**: https://tools.ietf.org/html/rfc6762
- **DNS RFC**: https://www.ietf.org/rfc/rfc1035.txt
- **Node.js mDNS**: https://www.npmjs.com/package/mdns
- **nftables Guide**: https://wiki.nftables.org/

---

**Good luck with your implementation! 🚀**  
Feel free to reach out if you hit any roadblocks.