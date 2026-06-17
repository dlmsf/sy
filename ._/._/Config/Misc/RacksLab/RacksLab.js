import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'
import ColorText from '../../../._/Util/ColorText.js'
import Qemu from '../../../._/Qemu/Qemu.js'
import fs from 'fs'
import VM from "./entities/VM.js";

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
                           },{up_buttontext : this.TextColor.pink('Run Commands'),
                               down_buttontext : this.TextColor.pink('Run Commands'),
                               up_emoji : '+',
                               down_emoji : '-',horizontal :true
                           })
   
   
                           await this.DropDown(uid,`files-${host.host}`,async () => {
                               if(this.FileManager.GetSelected(uid,host.host).length > 0){
                                   this.Button(uid,`${ColorText.green(`    ⚡ Send Now (${getTotalSize(this.FileManager.GetSelected(uid,host.host))})`)} `,{props : {sendfiles : host.host}}) 
                                }
                                this.File(uid,{name : host.host,startPath : '/home'})
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

this.OnEnter

                 }) 

                 await this.Page(uid,'customvm',async () => {
                   // await this.WaitLog(await VM.Config.create())
                   // await this.WaitLog(await VM.Config.find())
                    this.Text(uid,'• Racks Lab / Custom VM')
                    this.Button(uid,'customvmtest')
                    this.Button(uid,'<- Return',{props : {page : ''}})
                 })

                 await this.Page(uid,'config',async () => {
                    this.Text(uid,'• Racks Lab / Config')
                    this.Button(uid,'configtest')
                    this.Button(uid,'<- Return',{props : {page : ''}})
                 })

                 

            }
        )
    }
}

export default RacksLab