import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'
import ColorText from '../../../._/Util/ColorText.js'
import Qemu from '../../../._/Qemu/Qemu.js'

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

                 let racks = await SSH.scanNetwork({background : true,qemu : true})

                 //await this.WaitLog(racks)

                 this.Text(uid,`• Racks Lab | ${racks.cacheAge}`)

                racks.hosts.forEach(e => {
                    if(e.unlocked){
                        this.Button(uid,ColorText.green(e.host))
                    } else {
                        this.Button(uid,ColorText.red(e.host))
                    }
                   
                })
                this.Button(uid,' ')
                await this.DropDown(uid,'dropdownlaunch',() => {
                    this.Button(uid,'Alpine',{props : {alpine : true}})
                    this.Button(uid,'Ubuntu',{props : {ubuntu : true}})
                },{down_buttontext : 'Launch VM',up_buttontext : 'Launch VM',horizontal : true})
                this.Button(uid,' ')
              
                 this.Button(uid,{name :'<- Return',path : this.Storages.Get(uid,'parentfunc')})

            }
        )
    }
}

export default RacksLab