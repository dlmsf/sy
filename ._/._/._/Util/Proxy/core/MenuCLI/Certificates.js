import { readdirSync } from 'fs';

class Certificates {
  static List() {
    const certificateDir = '/etc/letsencrypt/live/';
    try {
      const domains = readdirSync(certificateDir).filter(domain => domain !== 'README');
      return domains;
    } catch (error) {
      console.error(`Error reading certificate directory: ${error}`);
      return [];
    }
  }
}

export default Certificates;
