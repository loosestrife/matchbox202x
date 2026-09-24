const yargs = require('yargs')
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).parse();
const dotenv = require('dotenv');

const conf = {
  packagePath: [
    '~/.local/share/matchbox/packages',
    //TODO: allow non unix use for some reason
    __dirname.split('/').slice(0,-2).join('/'),
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

console.log('conf is', conf);
module.exports = conf;