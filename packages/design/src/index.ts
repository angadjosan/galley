/**
 * Designs.
 *
 * A design is a small tree of boxes, text and images, laid out by flexbox, in
 * which every node carries its complete style as a closed set of utility class
 * names and every value comes from a named scale. `types.ts` argues why that is
 * the format and what the alternatives cost; this file is only the front door.
 *
 * The package is deliberately free of any browser dependency. The CLI parses,
 * lints and outlines designs; the canvas is the only thing that renders one,
 * and it lives in the app.
 */
export { parseDesign, encode, type ParseError, type ParseResult } from './parse.js';
export { serializeDesign, type SerializeOptions } from './serialize.js';
export {
  resolveClass,
  resolveClasses,
  SHADOW_ROLES,
  THEME_ROLES,
  VOCABULARY,
  type Declarations,
  type Resolution,
} from './classes.js';
export {
  DEFAULT_THEME,
  THEME_FENCE,
  checkContrast,
  contrastRatio,
  embedTheme,
  extractTheme,
  isThemeDocument,
  modeNames,
  modeOf,
  parseTheme,
  serializeTheme,
  themeToCss,
  toDtcg,
  type ContrastFinding,
  type ThemeDocument,
  type ThemeError,
  type ThemeMode,
  type ThemeParseResult,
} from './theme.js';
export { lintDesign, outline } from './lint.js';
export {
  find,
  isContainer,
  walk,
  type BoxLayer,
  type DesignDocument,
  type Frame,
  type ImageLayer,
  type Layer,
  type LayerId,
  type LayerKind,
  type LintFinding,
  type TextLayer,
} from './types.js';
export {
  applyOps,
  idAfter,
  type ApplyResult,
  type AuthoredOp,
  type DesignOp,
  type NewLayer,
} from './ops.js';
export { STARTERS, type DesignStarter } from './starters.js';
export { DESIGN_FENCE, extractDesign, embedDesign, isDesignDocument } from './embed.js';
