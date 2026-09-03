import readline from 'readline';

class TerminalHUD {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  ask(question) {
    return new Promise(resolve => {
      this.rl.question(question, answer => {
        resolve(answer);
      });
    });
  }

  async displayMenu(menuGenerator,config = {props : {},clearScreen : true,alert : undefined,alert_emoji : '⚠️'}) {
    if(config.clearScreen == undefined){config.clearScreen = true}
    if(config.props == undefined){config.props = {}}
    if (config.clearScreen == true) {
      console.clear();
    }

    const menu = menuGenerator(config.props);

    if (config.alert) {
      console.log(`${config.alert_emoji || '⚠️'}  ${config.alert}\n`);
    }
    console.log(menu.title);
    menu.options.forEach((option, index) => {
      console.log(`${index + 1}. ${option.name}`);
    });

    const choice = parseInt(await this.ask('\nChoose an option: '));
    const chosenOption = menu.options[choice - 1];

    if (chosenOption) {
      await chosenOption.action();
    } else {
      console.log('Invalid option, try again.');
      await this.displayMenu(menuGenerator);
    }
  }

  close() {
    this.rl.close();
  }
}

export default TerminalHUD