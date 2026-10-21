import Sy from './._/._/Sy.js'
import SyAPP from './._/SyAPP.js'

class SyManager {

static Start(name = 'sy'){
  new SyAPP(Sy,{mainFuncName : name})
}

}

if (import.meta.url === `file://${process.argv[1]}`) {
    SyManager.Start(process.argv[2])
}
  
export default SyManager