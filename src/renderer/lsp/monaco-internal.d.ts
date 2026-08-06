/**
 * Monaco ships no types for these deep ESM paths, which `model-loader.ts` reaches
 * into to patch `ITextModelService`. Members are `unknown` rather than `any` on
 * purpose: the shapes are internal and unstable, so each use has to narrow or
 * assert at the call site instead of silently inheriting `any`.
 */

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  /** Monaco's DI container — `get(id)` returns the service registered under `id`. */
  export const StandaloneServices: { get(id: unknown): unknown }
}

declare module 'monaco-editor/esm/vs/editor/common/services/resolverService.js' {
  /** Opaque service identifier for the text-model resolver. */
  export const ITextModelService: unknown
}
