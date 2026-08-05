---
"simpleedit": patch
---

Fix a mermaid diagram with a syntax error painting its giant "bomb" error
graphic over the app. Mermaid draws its own error diagram into a temporary node
it appends to `<body>` and then rethrows before cleaning it up, so the graphic
was left floating above the UI — one per failed render — even though the
markdown preview and gen-UI diagrams already show their own inline error
message. Both render sites now initialize mermaid with `suppressErrorRendering`.
