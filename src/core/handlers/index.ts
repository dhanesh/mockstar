// Satisfies: RT-1 — barrel re-export
export { buildHandlerRegistry, verifyHandlerReferences } from './registry.ts';
export type { HandlerRegistry, MockHandler, HandlerHelpers, FakerBundle } from './types.ts';
export { HandlerLoadError, MissingHandlerError } from './types.ts';
