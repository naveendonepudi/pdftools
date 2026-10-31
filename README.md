# PDF Tools

A fast, private PDF editor that runs entirely in your browser — think macOS Preview, on the web.

**We don't track or read your data.** Files are opened, edited and saved on your device. Nothing is uploaded, and there are no accounts, cookies, analytics or third-party scripts. The production build ships a strict Content Security Policy, so the page can't send your data to any other server.

## Features

- **Sign**: draw, type or upload a signature, then drag it into place and resize it.
- **Remove pages**: select one or more thumbnails and press Delete.
- **Insert pages**: add pages from another PDF, an image (JPG, PNG, WebP…) or a blank page (same size as the current page, A4 or Letter) at any position. You can also drop files between thumbnails.
- **Merge**: open several files at once, or use **Merge** to add more to the end. Then drag thumbnails to reorder pages.
- **Split**: every _N_ pages, by custom ranges (`1-3, 4-7, 9-`) or extract the selected pages. If there's more than one file, you get a `.zip`.
- **Rotate**, reorder, zoom (including pinch to zoom), and undo/redo for every change.
- Light and dark mode, keyboard shortcuts and a responsive layout.

| Shortcut | Action |
| --- | --- |
| ⌘/Ctrl + O | Open |
| ⌘/Ctrl + S | Download |
| ⌘/Ctrl + Z, ⇧⌘Z / Ctrl + Y | Undo / Redo |
| ⌘/Ctrl + A | Select all pages |
| Delete / Backspace | Delete selected pages (or the focused signature) |
| ⌘/Ctrl + `+` / `-` / `0` | Zoom in / out / fit width |
| Shift/⌘-click, ↑/↓ | Select ranges or several pages, move through pages |

## Performance

- Editing works on a lightweight list of page references, so deleting, inserting, reordering and rotating pages is instant. The PDF is only built once, when you download it ([pdf-lib](https://pdf-lib.js.org/)).
- Pages and thumbnails are rendered lazily with [pdf.js](https://mozilla.github.io/pdf.js/) in a Web Worker. Only pages near the viewport are rendered, and canvases far off-screen are released to save memory.
- No framework. The UI is plain TypeScript and CSS.

## Development

```bash
npm install
npm run dev      # start the dev server
npm test         # run unit tests (Vitest)
npm run build    # type-check and build to dist/
npm run preview  # serve the production build
```

`dist/` is a static site, so you can host it on any static file server (GitHub Pages, Netlify, S3…). The pdf.js fonts, character maps and decoders are self-hosted under `dist/pdfjs/`.
