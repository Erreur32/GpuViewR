// Build-time constants injected by scripts/build.mjs via esbuild --define.
// In tsx dev mode the literal stays undefined; consumers must guard with
// `typeof __AGENT_VERSION__ !== 'undefined'` so unit tests under tsx don't
// trip a ReferenceError.

declare const __AGENT_VERSION__: string;
