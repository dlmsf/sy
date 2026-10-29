import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'
import ColorText from '../../../._/Util/ColorText.js'
import Qemu from '../../../._/Qemu/Qemu.js'
import fs from 'fs'
import VM from "./entities/VM.js";
import objToArray from "../../../._/Util/objToArray.js";


function getTotalSize(paths) {
    const bytes = paths.reduce((sum, p) => {
        try { const s = fs.statSync(p); return s.isFile() ? sum + s.size : sum; } 
        catch { return sum; }
    }, 0);
    const i = bytes ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0;
    return `${bytes ? (bytes / Math.pow(1024, i)).toFixed(2) : 0} ${['Bytes','KB','MB','GB','TB'][i]}`;
}

class RacksLab extends SyAPP.Func(){
    constructor(){
        super('rackslab',
            async (props) => {
                 let uid = props.session.UniqueID

                 if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                if(props.customlaunch){
                    Qemu.startVM(props.customlaunch)
                    this.Alert(uid,' ')
                    this.Alert(uid,this.TextColor.green('CustomVM lauched !'))
                }

                 if(props.alpine){
                    Qemu.startVM()
                    this.Alert(uid,' ')
                    this.Alert(uid,this.TextColor.green('Alpine lauched !'))
                 }

                 if(props.ubuntu){
                    Qemu.startVM({os : 'ubuntu'})
                    this.Alert(uid,' ')
                    this.Alert(uid,this.TextColor.green('Ubuntu lauched !'))
                 }


                await this.Page(uid,'',async () => {


                    let racks = await SSH.scanNetwork({background : true,qemu : true})

                    //await this.WaitLog(racks)
   
                    this.Text(uid,`• Racks Lab | ${racks.cacheAge}`)

               
                    
   
                    if(props.connect){
                       await SSH.connect(props.connect)
                    }
   
                    if(props.unlock){
                       this.Alert(uid,' ')
                       this.Alert(uid,`${ColorText.brightWhite(props.unlock)} unlock requested !`)
                       SSH.fullSetup(props.unlock,'123')
                   }   
   
                   if(props.sendfiles){
                       SSH.scp(props.sendfiles,this.FileManager.GetSelected(uid,props.sendfiles))
                       this.FileManager.Reset(uid,props.sendfiles)
                       this.Alert(uid,' ')
                       this.Alert(uid,ColorText.brightWhite('SendFiles requested !'))
                   }
   
                   if(props.poweroff){
                       SSH.execBg(props.poweroff,'poweroff now')
                       this.Alert(uid,' ')
                       this.Alert(uid,ColorText.brightWhite('Poweroff requested !'))
                   }
   
                    for(let host of racks.hosts){
                       await this.DropDown(uid,host.host,async () => {
                           if(!host.unlocked){this.Button(uid,{name : '🔐 Unlock',props : {unlock : host.host}})}
                           this.Button(uid,{name : 'Connect',props :{connect : host.host}})
                           
                           await this.DropDown(uid,`commands-${host.host}`,async () => {
                               this.Buttons(uid,[{name :'One-line'},{name : 'Flow'}])
                           },{up_buttontext : this.TextColor.pink('Run'),
                               down_buttontext : this.TextColor.pink('Run'),
                               up_emoji : '+',
                               down_emoji : '-',horizontal :true
                           })
   
   
                           await this.DropDown(uid,`files-${host.host}`,async () => {
                               if(this.FileManager.GetSelected(uid,host.host).length > 0){
                                   this.Button(uid,`${ColorText.green(`    ⚡ Send Now (${getTotalSize(this.FileManager.GetSelected(uid,host.host))})`)} `,{props : {sendfiles : host.host}}) 
                                }
                                this.File(uid,{name : host.host,startPath : '/home'})
                                this.Button(uid,' ')
                           },{up_buttontext : this.TextColor.pink('Send Files'),
                               down_buttontext : this.TextColor.pink('Send Files'),
                               up_emoji : '+',
                               down_emoji : '-',
                           })
                         
                           this.Button(uid,this.TextColor.red('Poweroff'),{props : {poweroff : host.host}})
                       },{up_buttontext : (host.unlocked) ? ColorText.green(host.host) : ColorText.yellow(host.host),
                           down_buttontext :(host.unlocked) ? ColorText.green(host.host) : ColorText.yellow(host.host)
                       })
                    }
   
                   this.Button(uid,' ')
                   await this.DropDown(uid,'dropdownlaunch',() => {
                       this.Button(uid,'Alpine',{props : {alpine : true}})
                       this.Button(uid,'Ubuntu',{props : {ubuntu : true}})
                       this.Button(uid,'Custom',{props : {page : 'customvm'}})
                   },{down_buttontext : 'Launch VM',up_buttontext : 'Launch VM',horizontal : true})
                   this.Button(uid,' ')
                   

                   this.Buttons(uid,[
                    {name :'<- Return',path : this.Storages.Get(uid,'parentfunc')},
                    {name : this.TextColor.cyan('Config'),props : {page : 'config'}}
                   ])


                 }) 

                 await this.Page(uid,'customvm',async () => {

                    this.Text(uid,'• Racks Lab / Custom VM')

                   
                    this.OnPageEveryEnter(uid,'customvm',async () => {
                        this.Storages.Set(uid,'vmfields',VM.Config.fields)
                    })

                    if(props.valuechange){
                        this.DropDownManager.Close(uid,props.valuechange.key)
                        let actual = this.Storages.Get(uid,'vmfields')
                        actual[actual.findIndex(e => e.name == props.valuechange.key)].value = props.valuechange.value
                        this.Storages.Set(uid,'vmfields',actual)
                    }

                    if(props.inputValue){
                        if(props.key){
                        let actual = this.Storages.Get(uid,'vmfields')
                        actual[actual.findIndex(e => e.name == props.key)].value = props.inputValue
                        this.Storages.Set(uid,'vmfields',actual)
                        }
                    }

                    if(props.customnewvalue){
                        this.WaitInput(uid,{props : {page : 'customvm',key : props.customnewvalue.key}})
                    }
                    
                    
                    await this.DropDown(uid,'vmconfig',async () => {
                        if(this.Storages.Get(uid,'vmfields').length){
                            for(let instance of this.Storages.Get(uid,'vmfields')){
                                if(instance.possibleValues){
                                    await this.DropDown(uid,instance.name,() => {
                                        {
                                            if(instance.possibleValues){
                                                let buttons = []
                                                instance.possibleValues.forEach(e => {buttons.push({props : {valuechange : {key : instance.name,value : String(e)}},name : `${instance.value ? (instance.value == e ? '» ' : '') : (instance.default && instance.default == e ? '» ' : '')}${String(e)}`})})
                                                this.Buttons(uid,buttons)
                                            }
                                        }
                                    },{up_buttontext : `${instance.name}${(instance.value) ? ` : ${instance.value}`: (instance.default) ? ` : ${instance.default}`: ''}`,down_buttontext : `${instance.name}${(instance.value) ? ` : ${instance.value}`: (instance.default) ? ` : ${instance.default}`: ''}`})
                                } else {
                                    this.Button(uid,`${instance.name}${(instance.value) ? ` : ${instance.value}`: (instance.default) ? ` : ${instance.default}`: ''}`,{props : {customnewvalue : {key : instance.name}}})
                                }
                               
                            }
                           }

                    },{up_buttontext : 'VM Configuration',down_buttontext : 'VM Configuration'})

                    


                    await this.DropDown(uid,'startcommands',async () => {

                        await this.DropDown(uid,`newcommand-vmconfig`,async () => {
                            this.Buttons(uid,[{name :'One-line'},{name : 'Flow'},{name : 'Load'}])
                        },{up_buttontext : this.TextColor.pink('New'),
                            down_buttontext : this.TextColor.pink('New'),
                            up_emoji : '+',
                            down_emoji : '-',horizontal :true
                        })


                    },{up_buttontext : 'Start Commands',down_buttontext : 'Start Commands'})



                            
                    await this.DropDown(uid,'vmfiles',async () => {
                        this.File(uid,{startPath : '/home'})
                    },{up_buttontext : 'Files',down_buttontext : 'Files'})


                 
                    let creation = {}
                    this.Storages.Get(uid,'vmfields').forEach(e => {
                        if(e.value){ creation[e.name] = e.value}
                    })

                    let launchbuttons = [{name : ColorText.lime('◈  Launch VM'),props : {customlaunch : creation,page : ''}}]
                    launchbuttons.push({name : 'Save'})
                    launchbuttons.push({name : 'Load'})
                    this.Button(uid,' ')
                    this.Buttons(uid,launchbuttons)
                    this.Button(uid,' ')
                    let lastbuttons = [{name : '<- Return',props : {page : ''}}]
                 
                    
                    
                    
                    this.Buttons(uid,lastbuttons)
                 })

                 await this.Page(uid,'config',async () => {

                   
                  
                    this.Text(uid,'• Racks Lab / Config')

                    // ============================================================
                    // DISTRO LIST — downloaded / existent distros
                    // ============================================================
                    this.Button(uid,' ')
                    this.Text(uid, this.TextColor.cyan('• Available Distros'))

                    let qemuDir = null
                    try {
                        const sysInfo = await Qemu.getSystemInfo()
                        qemuDir = sysInfo?.script?.directory
                    } catch (e) {}

                    let alpineReady = false
                    let ubuntuReady = false

                    if (qemuDir && fs.existsSync(qemuDir)) {
                        try {
                            const entries = fs.readdirSync(qemuDir)
                            for (const entry of entries) {
                                const lower = entry.toLowerCase()

                                if (entry.includes('-vm-')) {
                                    if (lower.startsWith('alpine')) alpineReady = true
                                    if (lower.startsWith('noble') || lower.startsWith('ubuntu')) ubuntuReady = true
                                    continue
                                }

                                const isImage = lower.endsWith('.qcow2') || lower.endsWith('.img') || lower.endsWith('.iso') || lower.endsWith('.raw')
                                if (!isImage) continue
                                if (lower.includes('alpine')) alpineReady = true
                                if (lower.includes('noble') || lower.includes('ubuntu')) ubuntuReady = true
                            }
                        } catch (e) {}
                    }

                    if (alpineReady) {
                        this.Button(uid, this.TextColor.brightGreen('✓ Alpine') + this.TextColor.dim('  ·  downloaded & ready'))
                    } else {
                        this.Button(uid, this.TextColor.brightYellow('○ Alpine') + this.TextColor.dim('  ·  not downloaded'))
                    }

                    if (ubuntuReady) {
                        this.Button(uid, this.TextColor.brightGreen('✓ Ubuntu') + this.TextColor.dim('  ·  downloaded & ready'))
                    } else {
                        this.Button(uid, this.TextColor.brightYellow('○ Ubuntu') + this.TextColor.dim('  ·  not downloaded'))
                    }

                    this.Button(uid,' ')
                    this.Button(uid,'<- Return',{props : {page : ''}})
                 })

                 

            }
        )
    }
}

export default RacksLab