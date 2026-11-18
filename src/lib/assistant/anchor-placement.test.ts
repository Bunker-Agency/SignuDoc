import assert from "node:assert/strict";
import { test } from "node:test";

import type { PageText } from "../pdf-text.ts";
import { fieldPlacementSchema } from "../schemas/field.ts";
import {
  ANCHOR_GAP_PT,
  type AnchoredField,
  DEFAULT_FIELD_SIZE_FRACTIONS,
  resolveAnchoredFields,
} from "./anchor-placement.ts";

const signers = [{ email: "dana@example.com", id: "signer-1" }];

function page(items: PageText["items"], pageNumber = 1): PageText {
  return { heightPt: 792, items, pageNumber, widthPt: 612 };
}

const label = (text: string, x = 72, y = 700, width = 90, height = 12) => ({
  height,
  text,
  width,
  x,
  y,
});

function field(
  text: string,
  position: "right" | "below" | "over",
  extra: Partial<AnchoredField> & { occurrence?: number } = {},
): AnchoredField {
  const { occurrence, ...rest } = extra;

  return {
    anchor: { occurrence, position, text },
    signer: "dana@example.com",
    type: "signature",
    ...rest,
  };
}

function placements(pages: PageText[], fields: AnchoredField[]) {
  const result = resolveAnchoredFields(pages, signers, fields);

  assert.equal(result.ok, true);

  return result.ok ? result.placements : [];
}

test("places a signature to the right of its label", () => {
  const [placed] = placements(
    [page([label("Client signature")])],
    [field("Client signature", "right")],
  );
  const size = DEFAULT_FIELD_SIZE_FRACTIONS.signature;

  assert.ok(placed);
  assert.equal(placed.page, 1);
  assert.equal(placed.type, "signature");
  assert.equal(placed.signerId, "signer-1");
  assert.ok(Math.abs(placed.x - (72 + 90 + ANCHOR_GAP_PT) / 612) < 1e-5);
  // Centred on the label's middle line.
  assert.ok(Math.abs(placed.y - (706 - (size.height * 792) / 2) / 792) < 1e-5);
});

test("matches case-insensitively with collapsed whitespace", () => {
  const [placed] = placements(
    [page([label("Client signature")])],
    [field("client   SIGNATURE", "right")],
  );

  assert.ok(placed);
});

test("matches across split text items", () => {
  const [placed] = placements(
    [page([label("Client", 72, 700, 40), label("signature", 118, 700, 60)])],
    [field("Client signature", "right")],
  );

  assert.ok(placed);
  assert.ok(Math.abs(placed.x - (118 + 60 + ANCHOR_GAP_PT) / 612) < 1e-5);
});

test("picks the second occurrence", () => {
  const [placed] = placements(
    [page([label("Date:", 72, 600, 30), label("Date:", 300, 650, 30)])],
    [field("Date:", "right", { occurrence: 2, type: "date" })],
  );

  assert.ok(placed);
  assert.ok(Math.abs(placed.x - (300 + 30 + ANCHOR_GAP_PT) / 612) < 1e-5);
});

test("counts occurrences within the given page", () => {
  const pages = [
    page([label("Date:", 72, 600, 30)], 1),
    page([label("Date:", 200, 100, 30)], 2),
  ];
  const [placed] = placements(pages, [
    {
      ...field("Date:", "right", { type: "date" }),
      anchor: { page: 2, position: "right", text: "Date:" },
    },
  ]);

  assert.equal(placed?.page, 2);
});

test("keeps a field near the right edge inside the page", () => {
  const [placed] = placements(
    [page([label("Sign here", 520, 700, 80)])],
    [field("Sign here", "right")],
  );

  assert.ok(placed);
  assert.ok(placed.x + placed.width <= 1 + 1e-9);
  assert.ok(placed.x >= 0);
});

test("keeps a field near the bottom and top edges inside the page", () => {
  const [low] = placements(
    [page([label("Sign here", 72, 780, 80)])],
    [field("Sign here", "below")],
  );
  const [high] = placements(
    [page([label("Sign here", 72, 0, 80)])],
    [field("Sign here", "over")],
  );

  assert.ok(low && low.y + low.height <= 1 + 1e-9);
  assert.ok(high && high.y >= 0);
});

test("places below and over", () => {
  const pages = [page([label("Sign here", 72, 500, 90)])];
  const [below, over] = placements(pages, [
    field("Sign here", "below"),
    field("Sign here", "over", { type: "initials" }),
  ]);
  const initials = DEFAULT_FIELD_SIZE_FRACTIONS.initials;

  assert.ok(below && over);
  assert.ok(Math.abs(below.x - 72 / 612) < 1e-5);
  assert.ok(Math.abs(below.y - (512 + ANCHOR_GAP_PT) / 792) < 1e-5);
  // Over is centred on the box and at least as wide as it.
  assert.ok(over.width >= 90 / 612 - 1e-9);
  assert.ok(Math.abs(over.x + over.width / 2 - (72 + 45) / 612) < 1e-5);
  assert.ok(Math.abs(over.y + over.height / 2 - 506 / 792) < 1e-5);
  assert.ok(over.width >= initials.width - 1e-9);
});

test("reports every problem at once", () => {
  const result = resolveAnchoredFields(
    [page([label("Client signature"), label("Date:", 72, 600, 30)])],
    signers,
    [
      field("Nowhere", "right"),
      { ...field("Date:", "right", { type: "date" }), signer: "nobody" },
      field("Date:", "right", { occurrence: 3, type: "date" }),
    ],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      { index: 0, message: `Couldn't find "Nowhere" in the document.` },
      { index: 1, message: `No signer matches "nobody".` },
      {
        index: 2,
        message: `"Date:" appears 1 times; occurrence 3 doesn't exist.`,
      },
    ],
  });
});

test("reports a page with no text", () => {
  const result = resolveAnchoredFields([page([])], signers, [
    field("Client signature", "right"),
  ]);

  assert.deepEqual(result, {
    ok: false,
    problems: [
      {
        index: 0,
        message:
          "This page has no text, so fields can't be placed by text. Place them on the prepare page instead.",
      },
    ],
  });
});

test("every placement passes fieldPlacementSchema", () => {
  const pages = [page([label("Sign here", 72, 500, 90)])];
  const all = placements(pages, [
    field("Sign here", "right"),
    field("Sign here", "below", { type: "text", required: false }),
    field("Sign here", "over", {
      label: "Plan",
      options: ["A", "B"],
      type: "dropdown",
    }),
    field("Sign here", "right", { group: "g1", type: "radio" }),
  ]);

  assert.equal(all.length, 4);

  for (const placement of all) {
    assert.equal(fieldPlacementSchema.safeParse(placement).success, true);
  }
});

test("reports a field the schema refuses, such as an optional signature", () => {
  const result = resolveAnchoredFields([page([label("Sign here")])], signers, [
    field("Sign here", "right", { required: false }),
  ]);

  assert.deepEqual(result, {
    ok: false,
    problems: [{ index: 0, message: "signature fields are always required" }],
  });
});

test("sizes a field as a fraction of the page, on any page size", () => {
  const a4: PageText = {
    heightPt: 842,
    items: [label("Sign here", 72, 500, 90)],
    pageNumber: 1,
    widthPt: 595,
  };
  const [placed] = placements([a4], [field("Sign here", "right")]);

  assert.ok(placed);
  assert.equal(placed.width, DEFAULT_FIELD_SIZE_FRACTIONS.signature.width);
  assert.equal(placed.height, DEFAULT_FIELD_SIZE_FRACTIONS.signature.height);
});
