import MenuCLI from "./MenuCLI.js"
import Proxy from '../../Proxy.js'
import Certificates from './Certificates.js'
import addHttp from '../useful/addHttp.js'

let rules = []
let proxyOptions = {
  allowHttp: false,
  checkPorts: true,
  configureFirewall: true,
  httpPort: 80,
  httpsPort: 443
}

let config_options = () => {
    let final_array = []
    
    // Proxy mode options
    final_array.push({
        name: `🔒 Proxy Mode: ${proxyOptions.allowHttp ? 'HTTP + HTTPS' : 'HTTPS Only'}`,
        action: async () => {
            proxyOptions.allowHttp = !proxyOptions.allowHttp
            MenuCLI.displayMenu(ConfigMenu, {
                props: { options: config_options() },
                alert: proxyOptions.allowHttp ? 'HTTP mode enabled' : 'HTTP mode disabled'
            })
        }
    })
    
    // Port management options
    final_array.push({
        name: `🔌 Port Management: ${proxyOptions.checkPorts ? 'Enabled' : 'Disabled'}`,
        action: async () => {
            proxyOptions.checkPorts = !proxyOptions.checkPorts
            MenuCLI.displayMenu(ConfigMenu, {
                props: { options: config_options() },
                alert: proxyOptions.checkPorts ? 'Port management enabled' : 'Port management disabled'
            })
        }
    })
    
    // Firewall configuration
    final_array.push({
        name: `🛡️ Firewall Config: ${proxyOptions.configureFirewall ? 'Enabled' : 'Disabled'}`,
        action: async () => {
            proxyOptions.configureFirewall = !proxyOptions.configureFirewall
            MenuCLI.displayMenu(ConfigMenu, {
                props: { options: config_options() },
                alert: proxyOptions.configureFirewall ? 'Firewall configuration enabled' : 'Firewall configuration disabled'
            })
        }
    })
    
    // Custom ports
    final_array.push({
        name: `🔧 Custom Ports: HTTP:${proxyOptions.httpPort} HTTPS:${proxyOptions.httpsPort}`,
        action: async () => {
            let httpPort = await MenuCLI.ask(`HTTP Port (current: ${proxyOptions.httpPort}): `)
            if (httpPort && !isNaN(httpPort)) {
                proxyOptions.httpPort = parseInt(httpPort)
            }
            
            let httpsPort = await MenuCLI.ask(`HTTPS Port (current: ${proxyOptions.httpsPort}): `)
            if (httpsPort && !isNaN(httpsPort)) {
                proxyOptions.httpsPort = parseInt(httpsPort)
            }
            
            MenuCLI.displayMenu(ConfigMenu, {
                props: { options: config_options() },
                alert: 'Ports updated'
            })
        }
    })
    
    // Separator
    final_array.push({
        name: '─'.repeat(30),
        action: () => {}
    })
    
    // Start proxy
    final_array.push({
        name: '⚡ Start Proxy',
        action: async () => {
            if (rules.length) {
                let start_result = await Proxy.SyPM(rules, proxyOptions)
                if (start_result) {
                    MenuCLI.displayMenu(ConfigMenu, {
                        alert_emoji: '✔️',
                        alert: 'Proxy running',
                        props: { options: config_options() }
                    })
                } else {
                    MenuCLI.displayMenu(ConfigMenu, {
                        alert: 'Proxy init error!',
                        props: { options: config_options() }
                    })
                }
            } else {
                MenuCLI.displayMenu(ConfigMenu, {
                    alert: 'Please add at least one rule',
                    props: { options: config_options() }
                })
            }
        }
    })
    
    // Separator
    final_array.push({
        name: '─'.repeat(30),
        action: () => {}
    })
    
    // Certificate-based domains
    let cert_array = Certificates.List()
    cert_array.forEach(e => {
        const ruleIndex = rules.findIndex(rule => rule.domain === e)
        const useHttps = ruleIndex !== -1 ? rules[ruleIndex].useHttps !== false : true
        
        final_array.push({
            name: `${ruleIndex !== -1 ? '✔️' : '➕'} ${e}${ruleIndex !== -1 ? ` -> ${rules[ruleIndex].target}` : ''} ${useHttps ? '🔒' : '🔓'}`,
            action: async () => {
                let ask_result
                if (ruleIndex === -1) {
                    ask_result = await MenuCLI.ask('Type the target: ')
                    ask_result = addHttp(ask_result)
                    
                    // Ask for HTTPS preference
                    let httpsChoice = await MenuCLI.ask('Use HTTPS? (y/n): ')
                    let useHttps = httpsChoice.toLowerCase() !== 'n'
                    
                    rules.push({
                        domain: e,
                        target: ask_result,
                        useHttps: useHttps
                    })
                } else {
                    ask_result = await MenuCLI.ask('Type the target, REMOVE to disable, or TOGGLE for HTTP/HTTPS: ')
                    
                    if (ask_result === 'REMOVE') {
                        rules.splice(ruleIndex, 1)
                    } else if (ask_result === 'TOGGLE') {
                        rules[ruleIndex].useHttps = rules[ruleIndex].useHttps === false
                    } else {
                        ask_result = addHttp(ask_result)
                        rules[ruleIndex].target = ask_result
                    }
                }
                MenuCLI.displayMenu(ConfigMenu, {
                    props: { options: config_options() }
                })
            }
        })
    })
    
    // Allow custom domains without certificates (HTTP only)
    final_array.push({
        name: '➕ Add HTTP Domain (No Certificate)',
        action: async () => {
            let domain = await MenuCLI.ask('Type the domain: ')
            let target = await MenuCLI.ask('Type the target: ')
            target = addHttp(target)
            
            rules.push({
                domain: domain,
                target: target,
                useHttps: false
            })
            
            MenuCLI.displayMenu(ConfigMenu, {
                props: { options: config_options() }
            })
        }
    })
    
    final_array.push({
        name: '← Voltar',
        action: () => {
            MenuCLI.displayMenu(StartMenu)
        }
    })
    
    return final_array
}

const ConfigMenu = (props) => ({
    title: `⚙️ Proxy Config
`,
    options: props.options
})

const StartMenu = () => ({
    title: `✔️ Proxy Menu
`,
    options: [
        {
            name: '🌐 Configure Proxy',
            action: async () => {
                rules = []
                proxyOptions = {
                    allowHttp: false,
                    checkPorts: true,
                    configureFirewall: true,
                    httpPort: 80,
                    httpsPort: 443
                }
                MenuCLI.displayMenu(ConfigMenu, {
                    props: { options: config_options() }
                })
            }
        },
        {
            name: '📋 View Current Configuration',
            action: () => {
                let config = `Current Configuration:\n\n`
                config += `Proxy Mode: ${proxyOptions.allowHttp ? 'HTTP + HTTPS' : 'HTTPS Only'}\n`
                config += `Port Management: ${proxyOptions.checkPorts ? 'Enabled' : 'Disabled'}\n`
                config += `Firewall Config: ${proxyOptions.configureFirewall ? 'Enabled' : 'Disabled'}\n`
                config += `HTTP Port: ${proxyOptions.httpPort}\n`
                config += `HTTPS Port: ${proxyOptions.httpsPort}\n\n`
                
                if (rules.length > 0) {
                    config += `Rules:\n`
                    rules.forEach(rule => {
                        config += `  ${rule.domain} -> ${rule.target} (${rule.useHttps !== false ? 'HTTPS' : 'HTTP'})\n`
                    })
                } else {
                    config += `No rules configured\n`
                }
                
                MenuCLI.displayMenu(StartMenu, {
                    alert: config
                })
            }
        }
    ]
})

export default StartMenu