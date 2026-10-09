const yargs = require('yargs')
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).parse();
const dotenv = require('dotenv');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'conf' });

const conf = {
  packagePath: [
    '~/.local/share/matchbox/packages',
    //TODO: allow non unix use for some reason
    __dirname.split('/').slice(0,-1).join('/'),
  ]
};

{
  const dirsKeys = ['packagePath'];
  for(const key of dirsKeys){
    conf[key].forEach((dir, i) => {
      if(conf[key][i].startsWith('~')){
        // this isnt even correct ~ expansion
        conf[key][i] = process.env.HOME + conf[key][i].slice(1);
      }
    });
  }
}

logger.info('cool-http-bridge configuration:', conf);
module.exports = conf;