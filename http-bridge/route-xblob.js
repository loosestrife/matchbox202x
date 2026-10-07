const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'route-xblob' });

module.exports = ({ X, clientWin }) => {
  const routerWin = () => xintent.routerWin;

  const routeXBlobCreate = async (req, res) => {
    const blobData = req.body || {};
    logger.info(`POST /xblob/XBlobCreate`, blobData);
    const blobId = await xintent.XBlobCreate(X, routerWin(), clientWin, blobData);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId, blob: blobId });
  };

  const routeXBlobTransfer = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const targetBlob = Number(blobId || blob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`POST /xblob/XBlobTransfer blob=${targetBlob} grantee=${granteeWin}`);
    await xintent.XBlobTransfer(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobGrant = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const targetBlob = Number(blobId || blob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`POST /xblob/XBlobGrant blob=${targetBlob} grantee=${granteeWin}`);
    await xintent.XBlobGrant(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobUnlink = async (req, res) => {
    const { blobId, blob } = req.body || {};
    const targetBlob = Number(blobId || blob);
    logger.info(`POST /xblob/XBlobUnlink blob=${targetBlob}`);
    await xintent.XBlobUnlink(X, routerWin(), clientWin, targetBlob);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobBroadcast = async (req, res) => {
    const { blobId, blob, host, version } = req.body || {};
    const targetBlob = Number(blobId || blob);
    logger.info(`POST /xblob/XBlobBroadcast blob=${targetBlob} version=${version}`);
    await xintent.XBlobBroadcast(X, routerWin(), clientWin, targetBlob, host, version);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  return {
    routeXBlobCreate,
    routeXBlobTransfer,
    routeXBlobGrant,
    routeXBlobUnlink,
    routeXBlobBroadcast,
  };
};
