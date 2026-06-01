import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'
import ColorText from '../../../._/Util/ColorText.js'

class RacksLab extends SyAPP.Func(){
    constructor(){
        super('rackslab',
            async (props) => {
                 let uid = props.session.UniqueID

                 if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                 let racks = await SSH.scanNetwork({background : true})

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
                 this.Button(uid,{name :'<- Return',path : this.Storages.Get(uid,'parentfunc')})

            }
        )
    }
}

export default RacksLab