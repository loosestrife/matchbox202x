// xaudio.js
const {atoms, widString} = require('../util/xintent');
const {X, root, routerWin} = require('./index.js');

const xaudioOutputs = [];
const handleXAudioGetAudioOutputsV0 = {};
const handleXAudioPlayV0 = {};
const handleXAudioControlV0 = {};

module.exports = {
  handleXAudioGetAudioOutputsV0,
  handleXAudioPlayV0,
  handleXAudioControlV0,
};