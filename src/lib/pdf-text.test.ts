import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { readPdfText } from "./pdf-text.ts";

test("readPdfText returns text boxes with a top-left origin", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);

  page.drawText("Client signature", { font, size: 12, x: 72, y: 700 });

  const pages = await readPdfText(await pdf.save());

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.widthPt, 612);
  assert.equal(pages[0]?.heightPt, 792);

  const item = pages[0]?.items.find((entry) =>
    entry.text.includes("Client signature"),
  );

  assert.ok(item);
  assert.ok(Math.abs(item.x - 72) < 1);
  // The baseline is 92 pt from the top; the box's top is a text height above.
  assert.ok(Math.abs(item.y + item.height - 92) < 1);
  assert.ok(item.width > 50);
});
