const chalk = require('chalk');
const conf = require('../conf'); 
const logLevels = ['error', 'warn', 'info', 'debug', 'trace'];
const logColors = ['red', 'yellow', 'green', 'blue', 'purple'];
const levelColors = Object.fromEntries(logLevels.map((level, i) => [level, logColors[i]]));
const log = (level, ...args) => {
  console.log(
    chalk[levelColors[level]](
      `[${formatTime(new Date)}][${level.padStart(' ', 5)}] ${args[0]}`
    ),
    ...args.slice(1)
  );
}
module.exports = ({module}) => {
  const logger = {module};
  for(const level of logLevels){
    logger[level] = (...args)=>{
      // check conf.logger.level
      // check conf.logger.traceModules.includes(module)
      log(level, ...args);
    }
  }
  return logger;
}

function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}