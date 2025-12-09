// lib/mdns-listener.js
const Bonjour = require('bonjour');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const path = require('path');

class ChromecastDiscovery {
  constructor() {
    this.devicesFile = path.resolve('data/devices.json');
    this.bonjour = new Bonjour();
  }

  async start() {
  console.log('🚀 Starting Chromecast Discovery...');

  const browser = this.bonjour.find({ type: 'googlecast', protocol: 'tcp' });

  browser.on('up', async (service) => {
    console.log('\n📡 Found service:', service.name);
    console.log('Addresses:', service.addresses);

    const ip = service.addresses?.find(addr => addr.startsWith('192.168.25.')) 
               || service.addresses[0];

    if (!ip) {
      console.warn('⚠️ No usable IP found for service:', service.name);
      return;
    }

    console.log(`Using IP: ${ip}`);

    try {
      const deviceInfo = await this.fetchDeviceInfo(ip);
      await this.saveDevice(deviceInfo);
      console.log(`✅ Saved: ${deviceInfo.friendly_name}`);
    } catch (error) {
      console.error(`❌ Error processing ${ip}:`, error.message);
    }
  });

  browser.start(); // ← important!
  console.log('✅ Listening for Chromecasts on your network...');
}


  async fetchDeviceInfo(ip) {
    try {
      const response = await axios.get(`http://${ip}:8008/ssdp/device-desc.xml`, {
        timeout: 5000,
      });

      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(response.data);
      const device = result.root.device[0];

      return {
        uuid: device.UDN[0].replace('uuid:', ''),
        friendly_name: device.friendlyName[0],
        ip: ip,
        last_seen: new Date().toISOString(),
        room: device.roomName ? device.roomName[0] : null,
      };
    } catch (error) {
      throw new Error(`Failed to fetch device info from ${ip}: ${error.message}`);
    }
  }

  async saveDevice(deviceInfo) {
    let devices = [];

    try {
      const data = await fs.readFile(this.devicesFile, 'utf8');
      devices = JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('⚠️ Failed to read devices.json:', error.message);
      }
    }

    const index = devices.findIndex(d => d.uuid === deviceInfo.uuid);
    if (index >= 0) {
      devices[index] = { ...devices[index], ...deviceInfo };
    } else {
      devices.push(deviceInfo);
    }

    await fs.mkdir(path.dirname(this.devicesFile), { recursive: true });
    await fs.writeFile(this.devicesFile, JSON.stringify(devices, null, 2));
  }
}

module.exports = ChromecastDiscovery;
