/// <reference types="vite/client" />

// Vite's ambient module declarations: `import './app.css'` for its side effect,
// `?worker` imports, `import.meta.env`. Both bundles are Vite builds and share
// one tsconfig, so declaring it once here also covers the renderer's identical
// CSS and Monaco-worker imports — which is why this is a reference rather than
// a hand-written `declare module '*.css'`.
