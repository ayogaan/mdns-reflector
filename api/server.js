const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());
const projectRoot = path.resolve(__dirname, '..'); // one level up from api
const tokensFile = path.join(projectRoot, 'data', 'tokens.json');
const pairingsFile = path.join(projectRoot, 'data', 'pairings.json');
app.use('/tv-app', express.static(path.join(projectRoot, 'tv-app')));

// Generate pairing token for TV
app.post('/api/rooms/:room/pairing-token', async (req, res) => {
  const room = req.params.room;
  const token = crypto.randomBytes(16).toString('hex');
  
  console.log(`\n🎫 Generating pairing token for Room ${room}`);
  
  let tokens = {};
  try {
    const data = await fs.readFile(tokensFile, 'utf8');
    tokens = JSON.parse(data);
  } catch (e) {
    console.log('   📝 Creating new tokens file');
  }
  
  tokens[token] = {
    room: room,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };
  
  await fs.writeFile(tokensFile, JSON.stringify(tokens, null, 2));
  
  // Use the router's IP on guest VLAN for pairing URL
  const pairingURL = `http://192.168.20.1:3000/pair?token=${token}`;
  const qrImage = await QRCode.toDataURL(pairingURL);
  
  console.log(`   ✅ Token: ${token}`);
  console.log(`   🔗 URL: ${pairingURL}`);
  
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
  
  // Extract real IP (handle X-Forwarded-For if behind proxy)
  let guestIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress;
  
  // Clean up IPv6 mapped IPv4 addresses
  if (guestIP.startsWith('::ffff:')) {
    guestIP = guestIP.substring(7);
  }
  
  console.log(`\n📱 Pairing request from ${guestIP}`);
  console.log(`   🎫 Token: ${token}`);
  
  // Validate token
  let tokens = {};
  try {
    const data = await fs.readFile(tokensFile, 'utf8');
    tokens = JSON.parse(data);
  } catch (e) {
    console.error('   ❌ Cannot read tokens file');
    return res.status(500).send('Server error');
  }
  
  const tokenData = tokens[token];
  if (!tokenData) {
    console.log('   ❌ Invalid token');
    return res.status(400).send('❌ Invalid pairing code');
  }
  
  if (new Date(tokenData.expires_at) < new Date()) {
    console.log('   ❌ Token expired');
    return res.status(400).send('❌ Pairing code expired. Please scan a new QR code.');
  }
  
  // Save pairing
  let pairings = {};
  try {
    const data = await fs.readFile(pairingsFile, 'utf8');
    pairings = JSON.parse(data);
  } catch (e) {
    console.log('   📝 Creating new pairings file');
  }
  
  pairings[guestIP] = {
    room: tokenData.room,
    paired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), // 12 hours
    token_used: token
  };
  
  await fs.writeFile(pairingsFile, JSON.stringify(pairings, null, 2));
  
  console.log(`   ✅ Paired ${guestIP} → Room ${tokenData.room}`);
  console.log(`   ⏰ Expires: ${pairings[guestIP].expires_at}`);
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pairing Successful</title>
        <style>
          body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            padding: 50px 20px;
            margin: 0;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
          }
          .success { 
            font-size: 96px; 
            margin: 30px 0;
            animation: bounce 1s ease;
          }
          @keyframes bounce {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
          }
          h1 { 
            font-size: 48px; 
            margin: 20px 0; 
            font-weight: 600;
          }
          p { 
            font-size: 24px; 
            margin: 15px 0;
            opacity: 0.95;
          }
          .room {
            background: rgba(255,255,255,0.2);
            padding: 10px 30px;
            border-radius: 10px;
            display: inline-block;
            margin: 20px 0;
            font-weight: bold;
            font-size: 32px;
          }
          .instructions {
            max-width: 600px;
            margin: 30px auto;
            line-height: 1.6;
          }
        </style>
      </head>
      <body>
        <div class="success">✅</div>
        <h1>Pairing Successful!</h1>
        <div class="room">Room ${tokenData.room}</div>
        <div class="instructions">
          <p>You can now cast to the TV in this room</p>
          <p>📱 Open YouTube, Netflix, Spotify, or any Cast-enabled app</p>
          <p>🎬 Look for the Cast button and select your TV</p>
        </div>
      </body>
    </html>
  `);
});

// Status endpoint (useful for debugging)
app.get('/api/status', async (req, res) => {
  try {
    const pairings = JSON.parse(await fs.readFile(pairingsFile, 'utf8'));
    const tokens = JSON.parse(await fs.readFile(tokensFile, 'utf8'));
    
    res.json({
      active_pairings: Object.keys(pairings).length,
      active_tokens: Object.keys(tokens).length,
      pairings: pairings,
      tokens: tokens
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅ Cast Proxy API Server Started');
  console.log(`📡 Listening on http://0.0.0.0:${PORT}`);
  console.log(`🔗 Guest pairing: http://192.168.20.1:${PORT}/pair`);
  console.log(`📺 TV interface: http://192.168.30.1:${PORT}/tv-app/`);
  console.log('\n');
});