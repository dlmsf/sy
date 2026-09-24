import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'
import Sy from './._/._/Sy.js'

class SyManager {

static DB = SyDB
static PM = SyPM
static APP =  SyAPP

static async Start(name = 'sy'){
 
 await SyDB.Connect(name)
 new SyAPP(Sy,{mainFuncName : name})
 
}

}


if (import.meta.url === `file://${process.argv[1]}`) {
    SyManager.Start(process.argv[2])
  }
  
  
  export default SyManager
