/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const pdfjsDir = resolve(root, 'node_modules/pdfjs-dist');
/** pdf.js loads these on demand (fonts, character maps, image decoders, colour profiles). */
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

const MIME: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}

/** Serves (dev) and bundles (build) the pdf.js assets under `/pdfjs/` so they are self-hosted. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = resolve(pdfjsDir, `.${path}`);
        const top = relative(pdfjsDir, file).split(sep)[0];
        if (!file.startsWith(pdfjsDir + sep) || !PDFJS_ASSET_DIRS.includes(top) || !existsSync(file) || !statSync(file).isFile()) {
          return next();
        }
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        for (const file of walk(join(pdfjsDir, dir))) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${relative(pdfjsDir, file).split(sep).join('/')}`,
            source: readFileSync(file),
          });
        }
      }
    },
  };
}

/**
 * Adds a strict Content Security Policy to the production build. It prevents the page
 * from talking to any other origin, which guarantees documents never leave the device.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  base: './',
  plugins: [pdfjsAssets(), contentSecurityPolicy()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
