import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

// The version this deployment runs, compared with the latest release by
// "Check for updates" in Settings (src/lib/software-update.ts).
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SIGNUDOC_VERSION: version,
    // Whether Vercel BotID is on, decided once at build time so the browser
    // code that adds its proof and the server code that checks it cannot
    // disagree. It only works on Vercel, and is opt-in with BOTID=1. See
    // src/lib/security/botid.ts.
    NEXT_PUBLIC_BOTID:
      process.env.VERCEL === "1" && process.env.BOTID === "1" ? "1" : "",
  },
  // pdf.js reads the text of a draft's PDF on the server
  // (src/lib/pdf-text.ts). Bundled, it can't find its own worker file, so
  // Node loads it as an ordinary package instead.
  serverExternalPackages: ["pdfjs-dist"],
  images: {
    unoptimized: true,
  },
  // Finished PDFs are drawn with fonts read from disk at runtime, cut down
  // by a WebAssembly subsetter (src/lib/services/pdf-fonts.ts). Listing the
  // files here makes sure they are copied into the deployed functions.
  outputFileTracingIncludes: {
    "/api/**": [
      "./src/assets/fonts/*.ttf",
      "./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm",
      // pdf.js loads its worker file in-process by a computed path when it
      // reads a PDF's text (src/lib/pdf-text.ts), which tracing can't see.
      "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
};

export default nextConfig;
