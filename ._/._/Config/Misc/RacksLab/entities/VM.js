import SyDB from '../../../../../SyDB.js'

class VM {
    // Model for storing VM configuration (like a save)
    static Config = SyDB.Model('VMConfig', {
        name: { type: 'string', required: true, indexed: true },
        os: { type: 'string', default: 'alpine' },
        diskSize: { type: 'string', default: '5G' },
        memory: { type: 'number' },
        cpu: { type: 'number', default: 1 },
        port: { type: 'number' },
        bridge: { type: 'boolean', default: true },
        kvm: { type: 'boolean', default: true },
        sshSetup: { type: 'boolean', default: true },
        retryAttempts: { type: 'number', default: 18 },
        retryDelay: { type: 'number', default: 3 },
        createdAt: { type: 'string', default: () => new Date().toISOString() }
    })

    // Model for managing state of running VMs
    static State = SyDB.Model('VMState', {
        vmName: { type: 'string', required: true, indexed: true },
        pid: { type: 'number', required: true },
        status: { type: 'string', default: 'running' }, // 'running', 'stopped', 'error'
        ip: { type: 'string' },
        sshPort: { type: 'number' },
        tapInterface: { type: 'string' },
        logFile: { type: 'string' },
        startTime: { type: 'string', default: () => new Date().toISOString() },
        managed: { type: 'boolean', default: true },
        configName: { type: 'string' } // reference to VMConfig name
    })
}

export default VM