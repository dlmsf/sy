import MenuCLI from "./MenuCLI.js"
import PM2 from '../PM2.js'
import Proxy from '../../Proxy.js'
import Certificates from './Certificates.js'
import addHttp from '../useful/addHttp.js'

let rules = []

let config_options = () => {
    let final_array = []
    final_array.push({
        name : '⚡ Start',
        action : async () => {
            if(rules.length){
                let start_result = await Proxy.PM2(rules)
                if(start_result){
                    MenuCLI.displayMenu(ConfigMenu,{alert_emoji : '✔️',alert : 'Proxy running',props : {options : config_options()}})
                } else {
                    MenuCLI.displayMenu(ConfigMenu,{alert : 'Proxy init error !',props : {options : config_options()}})
                }
                
            } else {
                MenuCLI.displayMenu(ConfigMenu,{alert : 'Please add at least one rule',props : {options : config_options()}})
            }
        }
        })
    let cert_array =  Certificates.List()
    cert_array.forEach(e => {
        final_array.push({
            name : `${(rules.findIndex(rule => rule.domain == e) != -1) ? '✔️' : '➕'} ${e}${(rules.findIndex(rule => rule.domain == e) != -1) ? ` -> ${rules[rules.findIndex(rule => rule.domain == e)].target}`: '' }`,
            action : async () => {
                let ask_result
                if(rules.findIndex(rule => rule.domain == e) == -1){
                  ask_result = await MenuCLI.ask('Type the target : ')
                  ask_result = addHttp(ask_result)
                  rules.push({domain : e,target : ask_result})
                } else {
                ask_result = await MenuCLI.ask('Type the target or REMOVE to disable : ')
                if(ask_result == 'REMOVE'){
                    rules.splice(rules.findIndex(rule => rule.domain == e),1)
                } else {
                    ask_result = addHttp(ask_result)
                    rules[rules.findIndex(rule => rule.domain == e)].target = ask_result
                }
                }
                MenuCLI.displayMenu(ConfigMenu,{props : {options : config_options()}})
                }
            })
    })
final_array.push({
    name : '← Voltar',
    action : () => {
        MenuCLI.displayMenu(StartMenu)
        }
    })
return final_array
}


const ConfigMenu = (props) => ({
    title : `⚙️ Proxy Config
`,
options : props.options

})

const StartMenu = () => ({
    title : `✔️ Proxy Menu
`,
options : [
    {
    name : '🌐 Start Proxy',
    action : async () => {
        if(!(await PM2.Check())){
            await PM2.Install()
        }
        rules = []
        MenuCLI.displayMenu(ConfigMenu,{props : {options : config_options()}})
    }
    }
     ]

})

export default StartMenu