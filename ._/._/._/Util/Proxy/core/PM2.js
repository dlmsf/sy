import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class PM2 {
    static async Check() {
        try {
          const { stdout } = await execAsync('npm list -g pm2');
          if (stdout.includes('pm2@')) {
            return true; // PM2 is found in the list of global packages
          } else {
            return false; // PM2 is not found
          }
        } catch (error) {
          return false; // Error occurred, likely PM2 is not installed
        }
      }

  static async Install() {
    try {
      console.log('Installing PM2 globally...');
      const { stdout } = await execAsync('npm install -g pm2');
      console.log(stdout);
      console.log('PM2 has been installed successfully.');
    } catch (error) {
      console.error('Failed to install PM2:', error);
    }
  }
}

export default PM2