#!/usr/bin/env node

import TerminalHUD from "../TerminalHUD.js"
import StartMenu from "./StartMenu.js"

const MenuCLI = new TerminalHUD()

export default MenuCLI

MenuCLI.displayMenu(StartMenu)