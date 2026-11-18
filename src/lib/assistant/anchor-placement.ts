import { type z } from "zod";

import { fieldPlacementSchema } from "../schemas/field.ts";
import type { PageText } from "../pdf-text.ts";
import type { FieldType } from "../types/domain.ts";

// Works out where a field goes from the words around it. An assistant that
// wrote a contract knows its labels ("Client signature"), not coordinates:
// it names the text and a side, and this finds the text on the page.

export type FieldPlacementInput = z.input<typeof fieldPlacementSchema>;

export type AnchorPosition = "right" | "below" | "over";

export type AnchoredField = {
  signer: string;
  type: FieldType;
  anchor: {
    text: string;
    occurrence?: number;
    page?: number;
    position: AnchorPosition;
  };
  required?: boolean;
  label?: string;
  options?: string[];
  group?: string;
};

/**
 * The size of a field dropped on the prepare page, in points on a US Letter
 * page (612 x 792). The prepare page keeps these as fractions of the page
 * (`fieldTools` in src/components/envelopes/prepare-live-shell.tsx:
 * defaultWidth x 612, defaultHeight x 792, rounded), so a field placed here
 * looks like one the sender dropped.
 */
export const DEFAULT_FIELD_SIZES_PT: Record<
  FieldType,
  { width: number; height: number }
> = {
  checkbox: { height: 18, width: 18 },
  date: { height: 36, width: 73 },
  dropdown: { height: 36, width: 135 },
  initials: { height: 44, width: 86 },
  number: { height: 36, width: 98 },
  radio: { height: 18, width: 18 },
  signature: { height: 55, width: 147 },
  text: { height: 44, width: 110 },
};

export const ANCHOR_GAP_PT = 4;

const NO_TEXT_MESSAGE =
  "This page has no text, so fields can't be placed by text. Place them on the prepare page instead.";

type Box = { x: number; y: number; width: number; height: number };

// One character of a line and the box it sits in. A space put in between
// two items has no box.
type LineChar = { box: Box | null; char: string };

/** The lines of a page, top to bottom, each as its items left to right. */
function groupLines(page: PageText): PageText["items"][] {
  const sorted = [...page.items].sort(
    (a, b) => a.y + a.height - (b.y + b.height) || a.x - b.x,
  );
  const lines: Array<{ bottom: number; items: PageText["items"] }> = [];

  for (const item of sorted) {
    const bottom = item.y + item.height;
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.bottom - bottom) <= Math.max(item.height, 1) / 2,
    );

    if (line) {
      line.items.push(item);
    } else {
      lines.push({ bottom, items: [item] });
    }
  }

  return lines
    .sort((a, b) => a.bottom - b.bottom)
    .map((line) => line.items.sort((a, b) => a.x - b.x));
}

function lineChars(items: PageText["items"]): LineChar[] {
  const chars: LineChar[] = [];
  let previousRight: number | null = null;

  for (const item of items) {
    const letters = Array.from(item.text);
    const lineHeight = Math.max(item.height, 1);
    const last = chars[chars.length - 1];

    if (
      previousRight !== null &&
      item.x - previousRight > lineHeight / 4 &&
      last &&
      !/\s/.test(last.char) &&
      !/^\s/.test(item.text)
    ) {
      chars.push({ box: null, char: " " });
    }

    letters.forEach((letter, index) => {
      chars.push({
        box: {
          height: item.height,
          width: item.width / letters.length,
          x: item.x + (item.width * index) / letters.length,
          y: item.y,
        },
        char: letter,
      });
    });
    previousRight = Math.max(previousRight ?? -Infinity, item.x + item.width);
  }

  return chars;
}

/** Lowercase, with runs of whitespace as one space and no ends. */
function normalize(chars: LineChar[]): LineChar[] {
  const result: LineChar[] = [];

  for (const { box, char } of chars) {
    for (const lower of Array.from(char.toLowerCase())) {
      if (/\s/.test(lower)) {
        if (result.length > 0 && result[result.length - 1]?.char !== " ") {
          result.push({ box: null, char: " " });
        }
      } else {
        result.push({ box, char: lower });
      }
    }
  }

  if (result[result.length - 1]?.char === " ") {
    result.pop();
  }

  return result;
}

function normalizeText(text: string): string {
  return normalize(Array.from(text).map((char) => ({ box: null, char })))
    .map(({ char }) => char)
    .join("");
}

/** A page's lines of text as plain strings, top to bottom. */
export function pageLines(page: PageText): string[] {
  return groupLines(page)
    .map((items) =>
      lineChars(items)
        .map(({ char }) => char)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

type Match = { box: Box; pageNumber: number };

function unionBox(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return { height: bottom - top, width: right - left, x: left, y: top };
}

function findMatches(pages: PageText[], needle: string): Match[] {
  const matches: Match[] = [];

  for (const page of pages) {
    for (const items of groupLines(page)) {
      const chars = normalize(lineChars(items));
      const haystack = chars.map(({ char }) => char).join("");
      let from = 0;

      for (;;) {
        const at = haystack.indexOf(needle, from);

        if (at === -1) {
          break;
        }

        const boxes = chars
          .slice(at, at + needle.length)
          .flatMap(({ box }) => (box ? [box] : []));

        if (boxes.length > 0) {
          matches.push({ box: unionBox(boxes), pageNumber: page.pageNumber });
        }

        from = at + needle.length;
      }
    }
  }

  return matches;
}

function place(
  position: AnchorPosition,
  box: Box,
  size: { width: number; height: number },
  page: PageText,
): { x: number; y: number; width: number; height: number } {
  let { width } = size;
  const height = Math.min(size.height, page.heightPt);
  let x: number;
  let y: number;

  if (position === "right") {
    x = box.x + box.width + ANCHOR_GAP_PT;
    y = box.y + box.height / 2 - height / 2;
  } else if (position === "below") {
    x = box.x;
    y = box.y + box.height + ANCHOR_GAP_PT;
  } else {
    width = Math.max(width, box.width);
    x = box.x + box.width / 2 - width / 2;
    y = box.y + box.height / 2 - height / 2;
  }

  width = Math.min(width, page.widthPt);
  x = Math.min(Math.max(0, x), page.widthPt - width);
  y = Math.min(Math.max(0, y), page.heightPt - height);

  return { height, width, x, y };
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function resolveAnchoredFields(
  pages: PageText[],
  signers: ReadonlyArray<{ id: string; email: string }>,
  fields: AnchoredField[],
):
  | { ok: true; placements: FieldPlacementInput[] }
  | { ok: false; problems: Array<{ index: number; message: string }> } {
  const problems: Array<{ index: number; message: string }> = [];
  const placements: FieldPlacementInput[] = [];

  fields.forEach((field, index) => {
    const wanted = field.signer.trim().toLowerCase();
    const signer = signers.find(
      (candidate) =>
        candidate.id === field.signer.trim() ||
        candidate.email.toLowerCase() === wanted,
    );
    let failed = false;

    if (!signer) {
      problems.push({
        index,
        message: `No signer matches "${field.signer}".`,
      });
      failed = true;
    }

    const scope = field.anchor.page
      ? pages.filter((page) => page.pageNumber === field.anchor.page)
      : pages;
    let match: Match | undefined;

    if (scope.length > 0 && scope.every((page) => page.items.length === 0)) {
      problems.push({ index, message: NO_TEXT_MESSAGE });
      failed = true;
    } else {
      const needle = normalizeText(field.anchor.text);
      const matches = needle ? findMatches(scope, needle) : [];
      const occurrence = field.anchor.occurrence ?? 1;

      if (matches.length === 0) {
        problems.push({
          index,
          message: `Couldn't find "${field.anchor.text}" in the document.`,
        });
        failed = true;
      } else if (occurrence > matches.length) {
        problems.push({
          index,
          message: `"${field.anchor.text}" appears ${matches.length} times; occurrence ${occurrence} doesn't exist.`,
        });
        failed = true;
      } else {
        match = matches[occurrence - 1];
      }
    }

    if (failed || !signer || !match) {
      return;
    }

    const page = pages.find(
      (candidate) => candidate.pageNumber === match.pageNumber,
    );

    if (!page) {
      return;
    }

    const size = DEFAULT_FIELD_SIZES_PT[field.type];
    const placed = place(field.anchor.position, match.box, size, page);
    const width = round(placed.width / page.widthPt);
    const height = round(placed.height / page.heightPt);
    const placement: FieldPlacementInput = {
      groupId: field.group,
      height,
      label: field.label,
      options: field.options,
      page: page.pageNumber,
      signerId: signer.id,
      type: field.type,
      width,
      // Rounding down keeps the right and bottom edges inside the page.
      x: Math.min(
        round(placed.x / page.widthPt),
        Math.floor((1 - width) * 1e6) / 1e6,
      ),
      y: Math.min(
        round(placed.y / page.heightPt),
        Math.floor((1 - height) * 1e6) / 1e6,
      ),
    };

    if (field.required !== undefined) {
      placement.required = field.required;
    }

    const parsed = fieldPlacementSchema.safeParse(placement);

    if (!parsed.success) {
      problems.push({
        index,
        message: parsed.error.issues[0]?.message ?? "This field isn't valid.",
      });
      return;
    }

    placements.push(placement);
  });

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, placements };
}
