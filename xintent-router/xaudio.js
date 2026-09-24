// xaudio.js
const {atoms, widString} = require('../x11-promises/xintent.js');
const {X, root, routerWin} = require('./index.js');

const xaudioOutputs = [];
const handleXAudioGetAudioOutputsV0 = {};
const handleXAudioPlayV0 = {};
const handleXAudioControlV0 = {};
const xaudioUnregisterWindow = () => {};

module.exports = {
  handleXAudioGetAudioOutputsV0,
  handleXAudioPlayV0,
  handleXAudioControlV0,
  xaudioUnregisterWindow,
};