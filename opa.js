import SyAPP from "../../../usr/local/etc/SyManager/._/SyAPP.js"

export default class MyApp extends SyAPP.Func() {
  constructor() {
    super("untitled", async (props) => {
      const id = props.session.UniqueID
      // this.Cells(id, ...)
    })
  }
}