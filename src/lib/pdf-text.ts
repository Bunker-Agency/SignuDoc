import {
  EnvelopeDocumentAccessError,
  EnvelopeMutationError,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
} from "./envelopes.ts";

// Server-only: reads the text out of a PDF with pdf.js in Node. Never import
// this from client code. pdf.js runs here without a worker, and
// next.config.ts keeps pdfjs-dist out of the server bundle so it can load
// its own files.

export type PageText = {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  /** Boxes in PDF points, origin at the top left of the page. */
  items: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

export async function readPdfText(pdf: Uint8Array): Promise<PageText[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    data: new Uint8Array(pdf),
    useSystemFonts: false,
    verbosity: 0,
  });

  try {
    const document = await loadingTask.promise;
    const pages: PageText[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PageText["items"] = [];

      for (const item of content.items) {
        if (!("str" in item) || item.str === "") {
          continue;
        }

        // transform[4], transform[5] is the start of the baseline, with the
        // origin at the bottom left. The viewport moves it to the top left.
        const [x, baselineY] = viewport.convertToViewportPoint(
          item.transform[4],
          item.transform[5],
        );

        items.push({
          height: item.height,
          text: item.str,
          width: item.width,
          x,
          y: baselineY - item.height,
        });
      }

      pages.push({
        heightPt: viewport.height,
        items,
        pageNumber,
        widthPt: viewport.width,
      });
      page.cleanup();
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

/** The text of a draft's PDF, for the sender whose draft it is. */
export async function readDraftPdfText(
  userId: string,
  envelopeId: string,
): Promise<PageText[]> {
  const envelope = await getPrepareEnvelopeDataForUser(userId, envelopeId);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError("Only drafts can be read.", 409);
  }

  try {
    const document = await getDraftEnvelopeDocumentForUser(userId, envelopeId);

    return await readPdfText(document.body);
  } catch (error) {
    // Words the assistant can pass on, rather than an internal failure.
    if (error instanceof EnvelopeDocumentAccessError) {
      throw new EnvelopeMutationError(error.message, error.statusCode);
    }

    throw error;
  }
}
