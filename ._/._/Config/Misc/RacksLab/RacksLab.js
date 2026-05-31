import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'

class RacksLab extends SyAPP.Func(){
    constructor(){
        super('rackslab',
            async (props) => {
                 let uid = props.session.UniqueID

                 if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                 let racks = await SSH.scanNetwork({background : true})

                 this.Text(uid,'• Racks Lab')

                racks.hosts.forEach(e => {
                    this.Button(uid,e.host)
                })

                 this.Button(uid,{name :'<- Return',path : this.Storages.Get(uid,'parentfunc')})

            }
        )
    }
}

export default RacksLab