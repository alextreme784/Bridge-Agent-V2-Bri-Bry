/* ISO-2 aliases accepted alongside the BridgePro 3-letter codes */
const CODE_ALIASES = { VC: 'SVG', BB: 'BRB', LC: 'SLU', GD: 'GRD', DM: 'DMA', AG: 'ATG', KN: 'SKN', TT: 'TTO', JM: 'JAM', GY: 'GUY', BZ: 'BLZ', BS: 'BHS', TC: 'TCA' };
const VALID_COUNTRIES = ['SVG', 'BRB', 'SLU', 'GRD', 'DMA', 'ATG', 'SKN', 'TTO', 'JAM', 'GUY', 'BLZ', 'BHS', 'TCA'];

module.exports = function countryMiddleware(req, res, next) {
  const raw = req.headers['x-country-code'];
  if (!raw) {
    return res.status(400).json({ error: 'X-Country-Code header is required' });
  }
  const upper = raw.toUpperCase();
  const code  = CODE_ALIASES[upper] || upper;
  if (!VALID_COUNTRIES.includes(code)) {
    return res.status(400).json({ error: `Unknown country code: ${raw}` });
  }
  req.countryCode = code;
  next();
};
