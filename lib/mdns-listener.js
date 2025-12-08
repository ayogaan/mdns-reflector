// lib/mdns-listener.js (UPDATED)
const Bonjour = require('bonjour');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;

class ChromecastDiscovery {
  constructor() {
    this.devicesFile = 'data/devices.json';
    this.bonjour = new Bonjour();
  }

  async start() {
    console.log('🚀 Starting Chromecast Discovery...');
    
    // Browse for Chromecasts on vlan30
    const browser = this.bonjour.find({ 
      type: 'googlecast',
      protocol: 'tcp'
    });

    browser.on('up', async (service) => {
      // service.addresses is array of IPs
      const ip = service.addresses?.find(addr => 
        addr.startsWith('192.168.25.')
      ) || service.addresses[0];
      
      if (!ip) return;
      
      console.log(`\n📡 Found Chromecast at ${ip}`);
      
      try {
        const deviceInfo = await this.fetchDeviceInfo(ip);
        await this.saveDevice(deviceInfo);
        console.log(`✅ Saved: ${deviceInfo.friendly_name}`);
      } catch (error) {
        console.error(`❌ Error processing ${ip}:`, error.message);
      }
    });

    // Start browsing
    browser.start();
    console.log('✅ Listening for Chromecasts on vlan30...');
  }

  async fetchDeviceInfo(ip) {
    const response = await axios.get(`http://${ip}:8008/ssdp/device-desc.xml`, {
      timeout: 5000
    });
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