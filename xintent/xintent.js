async function connectToRouter(X, root) {
  // 1. Check if router is active
  const xintentAtom = await X.InternAtom(true, 'XINTENT');
  if (!xintentAtom) throw new Error('XINTENT system not running.');

  const prop = await X.GetProperty(0, root, xintentAtom, X.atoms.WINDOW, 0, 4);
  if (!prop || !prop.data || prop.data.length < 4) {
    throw new Error('XINTENT router window not found on root.');
  }
  const routerWin = prop.data.readUInt32LE(0);

  // 2. Negotiate protocol version
  const xintentV0Atom = await X.InternAtom(true, 'XINTENT_INTENT_V0');
  if (!xintentV0Atom) {
    throw new Error('Router does not support XINTENT_INTENT_V0 protocol.');
  }

  return { routerWin, xintentV0Atom };
}

module.exports = {connectToRouter};