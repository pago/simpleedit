---
"simpleedit": patch
---

Fix inconsistent file-tree icon alignment. The folder/file emoji previously sat in a width-less span, so the icon and label columns drifted with each glyph's rendered width. Pinning the icon into a fixed-width centered slot keeps every row's icon and label aligned regardless of font/glyph rendering.
