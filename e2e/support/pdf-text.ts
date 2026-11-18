/** The text a PDF shows, page after page, with runs of space made single. */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      parts.push(
        content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
      );
    }
  } finally {
    await document.destroy();
  }

  return parts.join("\n").replace(/\s+/g, " ");
}
