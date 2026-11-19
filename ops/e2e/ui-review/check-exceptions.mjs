// Automatic check results judged acceptable, each with the reason. An entry names the application, the
// rule and the element, as a string or a pattern matching the reported target. Only a result that is
// wrong about the interface belongs here; a real defect stays a finding until the product is fixed.
const YOUTUBE_PLAYER = 'Markup inside the YouTube player a static YouTube field embeds, which CEDAR does not author; ' +
  'whether it is checked at all depends on the embed loading in time.';
export const CHECK_EXCEPTIONS = ['metadata-editor', 'openview'].map(app =>
  ({app, rule: 'aria-prohibited-attr', target: /\.youtube-player >>> #movie_player$/, reason: YOUTUBE_PLAYER}));
