import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  SEED,
  resetBackend,
  setTileCount,
  visibleTextsUnder,
  watchOffOriginRequests,
  type OffOriginWatch
} from './fixtures.js';

/**
 * The dashboard's fill contract (HSD-n3nr), measured on the **real** backend
 * bench: a real store, the real `/api/entities` REST reads and the real `/ws`
 * snapshot, with the shipped CSS from `web/dist`.
 *
 * The owner's complaint was that two or three tiles render short at the top of
 * a 1280×720 panel. A screenshot would show that; it would not measure it, and
 * it could not say "94% of the content box" or "scrollHeight equals
 * clientHeight". So every assertion here is a bounding box, a scroll metric or a
 * computed font size, and there is not one image comparison in the file.
 *
 * This file covers HSD-enxf as well: the tiles must use the **horizontal** space
 * too, and the icon, state text and label must scale with the *tile's* own box
 * rather than with the viewport. In those later tests the "content box" is
 * `.content`'s **border box** — the element itself, padding included — because
 * that is the space the owner sees as the panel; `geometry.content` is the
 * padding-inset box the tiles may actually use, and the two are measured and
 * asserted separately on purpose.
 *
 * Three things are deliberately *not* asserted, because they belong elsewhere:
 * the ≤639px single-column rule (`scripts/check-dist.mjs` greps the built CSS),
 * the control rail's non-overlap (`dashboard.spec.ts`) and the tap behaviour
 * (`selection.spec.ts`).
 */

/** Every tile on the page, whatever its staleness. */
const TILES = 'ul.tiles li.tile';

/** A tile with the first real snapshot behind it (staleness cleared). */
const LIVE_TILES = 'ul.tiles li.tile[data-stale="false"]';

/**
 * The panel sizes the ticket names: the 1024×600 wall panel up to 1440p.
 *
 * Deliberately kept apart from `MATRIX` below. These are the four **landscape**
 * sizes the earlier fill tests were written against, and those tests (nine tiles
 * fit, the rail is never reached, no safety scroller) are tuned to exactly these
 * four. Folding portrait or ultrawide into this list would change what they
 * assert, so the two lists stay separate on purpose.
 */
const VIEWPORTS = [
  { width: 1024, height: 600 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

/**
 * The amendment's spread: every panel shape the layout has to look deliberate
 * on, not just the 1280×720 the owner reported. Portrait and ultrawide are here
 * because "resolution- and aspect-ratio-agnostic" is the claim being made; 4K is
 * here because an uncapped container-relative internal has to keep growing
 * there, and a px ceiling used to make it stop.
 *
 * A separate constant from `VIEWPORTS` on purpose — see the comment above. Do
 * not "unify" the two: folding portrait, ultrawide and 4K into `VIEWPORTS`
 * would change what the earlier fill tests assert, and dropping them silently
 * would lose the coverage this amendment added.
 */
const MATRIX = [
  { width: 1024, height: 600 }, // the wall panel
  { width: 1280, height: 720 }, // the reference panel
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 720, height: 1280 }, // portrait
  { width: 2560, height: 720 }, // ultrawide
  { width: 3840, height: 2160 } // 4K
] as const;

/** The 1024×600 panel: the smallest supported one, and the ticket's 9-tile case. */
const SMALLEST = VIEWPORTS[0];

/** The reference panel's kiosk viewport (1280×720): the size the owner reported. */
const PANEL = { width: 1280, height: 720 } as const;

/** `--tap` from `tokens.css`: no tile may be narrower than this (D26). */
const MIN_TILE_WIDTH = 48;

/** `--tap-primary` from `tokens.css`: no tile may be shorter than this (D26). */
const MIN_TILE_HEIGHT = 56;

/** Design 05 §2.1's track floor: a forced column count never goes below it. */
const TRACK_FLOOR = 240;

/** The offered steps (`ui.scale`), the same five the Appearance panel offers. */
const SCALE_STEPS = [85, 100, 115, 130, 150] as const;

/** One offered step, as the registry's percent integer (130, not 1.3). */
type ScaleStep = (typeof SCALE_STEPS)[number];

/**
 * The three panels AC 4 names for the scale matrix, smallest to largest.
 *
 * Literal sizes, not `VIEWPORTS` or `MATRIX`: those two lists are the earlier
 * fill tests' own contract (their comments say why they must not be folded
 * together), and "what does one zoom factor do to the same panel" is a third,
 * separate question. Adding these to either list would silently change what
 * those tests assert.
 */
const SCALE_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

/** The smallest step: every tap floor is measured here (AC 6). */
const SMALLEST_SCALE = 85;

/**
 * The four panels the control rail is measured on.
 *
 * The first two are the sizes the ticket names: the reference panel the owner
 * measured the rail at, and the wall panel. 1920x1080 is the largest landscape
 * panel, and portrait is last because D30 already asks every fixed floor to hold
 * there, and the rail is one of those floors (`--rail-control` squares in a
 * fixed column).
 *
 * A third constant, not `MATRIX`: the browser tier runs serially under a 300s
 * global timeout, and this test needs the shapes the ticket names, not all
 * seven. Adding these to `MATRIX` would also change what the fill tests assert
 * there, for the same reason `VIEWPORTS` and `MATRIX` stay apart.
 */
const RAIL_VIEWPORTS = [
  { width: 1280, height: 720 }, // the reference panel, where the owner measured it
  { width: 1024, height: 600 }, // the wall panel
  { width: 1920, height: 1080 }, // the largest landscape panel
  { width: 720, height: 1280 } // portrait (D30)
] as const;

/**
 * The five panels the header's two gutters are measured on (cd-qvt2).
 *
 * A fourth list, not `VIEWPORTS`, `MATRIX`, `SCALE_VIEWPORTS` or
 * `RAIL_VIEWPORTS`: each of those is another test's contract (the fill tests'
 * four landscape sizes, the amendment's seven shapes, the scale matrix and the
 * rail's four panels), and this test asks a fifth question — does the clock pin
 * the right gutter while the pills stay by the title — at the three landscape
 * panels the owner named plus the two narrow widths where the header has to
 * wrap instead of clip. Folding these into any of the others would change what
 * that test asserts, so the list stays its own.
 */
const HEADER_VIEWPORTS = [
  { width: 1280, height: 720 }, // the reference panel, the size the owner measured
  { width: 1024, height: 600 }, // the wall panel
  { width: 1920, height: 1080 },
  { width: 720, height: 1280 }, // portrait: the clock must wrap, not clip
  { width: 320, height: 568 } // the narrowest case the wrap has to survive
] as const;

/** The off-origin watch the `beforeEach` attached; asserted at the end of each test. */
let watch: OffOriginWatch;

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  watch = watchOffOriginRequests(page);
});

test.afterEach(async ({ request }) => {
  // The bench is one process for a whole run, and `/__test/reset` never deletes
  // a row a spec added: a synthetic tile left here would hand the *next* spec
  // file seven or nine tiles instead of the seed's six (`selection.spec.ts`
  // asserts exactly six).
  //
  // `resetBackend` comes first because `setTileCount` alone cannot undo a trim:
  // it deletes rows and can only add `sensor.layout_extra_*` ones back, so the
  // canonical rows this spec dropped would stay dropped. The reset re-upserts
  // all six; the prune that follows then removes every synthetic row.
  await resetBackend(request);
  await setTileCount(request, SEED.length);
  // The last test forces a column count and restores it itself; this is the
  // safety net for a run where it failed before reaching that restore, because
  // `/__test/reset` does not restore settings at all.
  await restoreColumns(request);
  // Same reason as `restoreColumns`: `/__test/reset` restores neither.
  await applyScale(request, 100);
});

/** One `getBoundingClientRect()` reading, narrowed to what a spec compares. */
interface BoxRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** The fill geometry collected in one page evaluation. */
interface FillGeometry {
  /** `.content`'s **content box** — the padding is not part of the tiles' area. */
  readonly content: BoxRect;
  /** `.content`'s own **border box**: the element, padding included. */
  readonly contentBorder: BoxRect;
  /** The control rail (D28), or `null` on a page that has none. */
  readonly rail: BoxRect | null;
  readonly tiles: readonly BoxRect[];
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
}

/** One tile's typography and icon, as the browser resolves them. */
interface TileInternals {
  readonly word: number;
  readonly name: number;
  readonly iconWidth: number;
  readonly iconHeight: number;
}

/**
 * Read the fill geometry once.
 *
 * `content` is `.content`'s `getBoundingClientRect()` inset by its own computed
 * padding: `.content`'s padding is space the tiles may not use anyway, so
 * counting it would report a padding-only "empty region". That padding is a
 * single `--gap` on the start edge and none on the end edge (the rail owns
 * that side), so the inset is the same 16px gutter the panel shows everywhere
 * rather than a viewport `clamp()` the coverage ratio would track instead of
 * the grid.
 *
 * `contentBorder` is that same rect **un-inset**. Both exist because they answer
 * two different questions, and neither can stand in for the other: HSD-enxf's
 * "content box" is the element itself (a tile may not cover the padding, and the
 * owner reads the padding as part of the panel), while the fill contract
 * (HSD-n3nr) is about the area the tiles are allowed to use. A max-width
 * centring column, for instance, shows up in `contentBorder` as a width share
 * far below 100% while the inset ratio still looks healthy.
 *
 * @param page the page showing the dashboard.
 */
async function measureFill(page: Page): Promise<FillGeometry> {
  return page.evaluate((): FillGeometry => {
    function boxOf(element: Element): BoxRect {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    }

    const content = document.querySelector('.content');
    if (content === null) {
      throw new Error('the dashboard has no .content area');
    }
    const rect = content.getBoundingClientRect();
    const style = getComputedStyle(content);
    const left = rect.left + parseFloat(style.paddingLeft);
    const right = rect.right - parseFloat(style.paddingRight);
    const top = rect.top + parseFloat(style.paddingTop);
    const bottom = rect.bottom - parseFloat(style.paddingBottom);

    const rail = document.querySelector('[data-testid="control-rail"]');

    return {
      content: { left, right, top, bottom, width: right - left, height: bottom - top },
      contentBorder: boxOf(content),
      rail: rail === null ? null : boxOf(rail),
      tiles: Array.from(document.querySelectorAll('ul.tiles li.tile')).map(boxOf),
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollTop: content.scrollTop
    };
  });
}

/**
 * Read the first tile's resolved word size, name size and icon box.
 *
 * `getComputedStyle` and a bounding box, not a class name: the tile's type is a
 * `cqi` container query, so only the browser can say what it resolves to.
 *
 * @param page the page showing the dashboard.
 */
async function measureInternals(page: Page): Promise<TileInternals> {
  return page.evaluate((): TileInternals => {
    const tile = document.querySelector('ul.tiles li.tile');
    if (tile === null) {
      throw new Error('the dashboard has no tile to measure');
    }
    const word = tile.querySelector('.state .word');
    const name = tile.querySelector('.name');
    const icon = tile.querySelector('.icon svg');
    if (word === null || name === null || icon === null) {
      throw new Error('the first tile must have a word, a name and an icon');
    }
    const iconRect = icon.getBoundingClientRect();
    return {
      word: parseFloat(getComputedStyle(word).fontSize),
      name: parseFloat(getComputedStyle(name).fontSize),
      iconWidth: iconRect.width,
      iconHeight: iconRect.height
    };
  });
}

/**
 * The rect enclosing every tile. The count assertion has already proved there
 * is at least one, so the `Math.min`/`Math.max` over an empty list cannot happen.
 */
function unionOf(tiles: readonly BoxRect[]): BoxRect {
  const left = Math.min(...tiles.map((tile) => tile.left));
  const right = Math.max(...tiles.map((tile) => tile.right));
  const top = Math.min(...tiles.map((tile) => tile.top));
  const bottom = Math.max(...tiles.map((tile) => tile.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** How much of the content box the tile union covers, as a ratio. */
function coverageOf(geometry: FillGeometry): number {
  const union = unionOf(geometry.tiles);
  return (union.width * union.height) / (geometry.content.width * geometry.content.height);
}

/**
 * The tile union's share of `.content`'s **border box**, per axis and by area.
 *
 * The sibling of `coverageOf`, against the element instead of the padding-inset
 * box: `coverageOf` answers "did the grid use the space it was given", this one
 * answers "did the tiles use the panel". A horizontal deficit that the padding
 * hides — a capped, centred column — only shows up here.
 *
 * @param geometry the measured fill geometry.
 */
function borderCoverageOf(geometry: FillGeometry): {
  readonly width: number;
  readonly height: number;
  readonly area: number;
} {
  const union = unionOf(geometry.tiles);
  const border = geometry.contentBorder;
  return {
    width: union.width / border.width,
    height: union.height / border.height,
    area: (union.width * union.height) / (border.width * border.height)
  };
}

/**
 * HSD-enxf's fill contract: the tiles cover at least 90% of the content box, in
 * **both axes** — the ticket's own criterion, and the one that names the defect.
 *
 * Two axes and not the area, deliberately. The area ratio is smaller by
 * construction, because `.content`'s own padding and the rail's column are
 * inside its border box and outside the tiles' reach: at 1280×720 the tiles
 * cover 98.6% of the width and 95.0% of the height, an area share of 93.7%.
 * Asserting the area would therefore not be a stricter version of the same
 * test — it would be a test of the panel inset, and since cd-bdjz that inset is
 * one `--gap` plus the derived rail column, so a later ticket that "improved"
 * the area share would be shrinking a 16px gutter, not filling the panel. The
 * axis shares are what the owner's complaint was about: an empty band down each
 * side, and one at the top.
 *
 * @param geometry the measured fill geometry.
 * @param detail the failure message, carrying the whole measurement.
 */
function expectTilesCoverContentBox(geometry: FillGeometry, detail: string): void {
  const share = borderCoverageOf(geometry);
  /** A ratio as a percentage, for the failure message. */
  function pct(ratio: number): string {
    return `${(ratio * 100).toFixed(1)}%`;
  }
  const context = `width ${pct(share.width)}, height ${pct(share.height)}, area ${pct(share.area)} — ${detail}`;
  expect(share.width, `the tiles do not use the width: ${context}`).toBeGreaterThanOrEqual(0.9);
  expect(share.height, `the tiles do not use the height: ${context}`).toBeGreaterThanOrEqual(0.9);
}

/** The whole geometry, so a failure names the panel and the numbers. */
function detailOf(label: string, geometry: FillGeometry): string {
  return `${label}: coverage ${coverageOf(geometry).toFixed(4)}, ${JSON.stringify(geometry)}`;
}

/**
 * The tiles grouped into rows by their rounded `top`, left to right.
 *
 * @param tiles the measured tile boxes.
 */
function rowsOf(tiles: readonly BoxRect[]): BoxRect[][] {
  const rows = new Map<number, BoxRect[]>();
  for (const tile of tiles) {
    const key = Math.round(tile.top);
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, [tile]);
    } else {
      row.push(tile);
    }
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/**
 * The shared "no large empty region and no overflow" assertions.
 *
 * @param geometry the measured fill geometry.
 * @param detail the failure message, carrying the whole measurement.
 */
function expectTilesFillContent(geometry: FillGeometry, detail: string): void {
  expect(coverageOf(geometry), detail).toBeGreaterThan(0.9);

  // Every row spans the content width. The coverage ratio above is a union of
  // all tiles, so it cannot see a hole *inside* that union: 4 tiles in a 3×2
  // grid covered 89% of a 1280×720 content box while two-thirds of the last row
  // was empty, and a 3+1 arrangement is exactly what this catches. 90% leaves
  // room for a rounding half-pixel, not for a missing column.
  for (const row of rowsOf(geometry.tiles)) {
    const left = Math.min(...row.map((tile) => tile.left));
    const right = Math.max(...row.map((tile) => tile.right));
    expect(right - left, `a row of ${row.length} tiles is not full — ${detail}`).toBeGreaterThanOrEqual(
      geometry.content.width * 0.9
    );
  }

  // A tile that leaves the content box is clipped by `.content`'s
  // `overflow-x: hidden`, or starts a horizontal scroll: either way it is a
  // layout bug the 90% ratio alone would not separate from a padding effect.
  for (const tile of geometry.tiles) {
    expect(tile.left, detail).toBeGreaterThanOrEqual(geometry.content.left - 1);
    expect(tile.top, detail).toBeGreaterThanOrEqual(geometry.content.top - 1);
    expect(tile.right, detail).toBeLessThanOrEqual(geometry.content.right + 1);
    expect(tile.bottom, detail).toBeLessThanOrEqual(geometry.content.bottom + 1);
  }
}

/**
 * Put `ui.dashboard_columns` back to auto-fit (0), the way
 * `dashboard.spec.ts` puts `audio.volume` back: `/__test/reset` restores
 * neither — the bench's `CANONICAL_SETTINGS` carries no `ui.dashboard_columns`.
 *
 * @param request the test's API request context.
 */
async function restoreColumns(request: APIRequestContext): Promise<void> {
  const restore = await request.patch('/api/settings', { data: { 'ui.dashboard_columns': 0 } });
  expect(restore.ok(), await restore.text()).toBe(true);
}

/**
 * Point the bench at *count* tiles, mount the dashboard at *viewport* and wait
 * for the live snapshot, which is what gives the tiles their real content and
 * therefore their real height.
 *
 * @param page the page to drive.
 * @param request the test's API request context.
 * @param count how many tiles the dashboard must show.
 * @param viewport the panel size to measure at.
 */
async function openWithTiles(
  page: Page,
  request: APIRequestContext,
  count: number,
  viewport: { readonly width: number; readonly height: number }
): Promise<void> {
  await setTileCount(request, count);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto('/');
  const detail = `${count} tiles at ${viewport.width}x${viewport.height}`;
  await expect(page.locator(TILES), detail).toHaveCount(count);
  await expect(page.locator(LIVE_TILES)).toHaveCount(count);
}

/**
 * Store `ui.scale` through the real settings PATCH, like `restoreColumns`.
 *
 * @param request the test's API request context.
 * @param step the step to store, as the registry's percent integer.
 */
async function applyScale(request: APIRequestContext, step: ScaleStep): Promise<void> {
  const patch = await request.patch('/api/settings', { data: { 'ui.scale': step } });
  expect(patch.ok(), await patch.text()).toBe(true);
}

/**
 * Store `audio.rail_target` through the real settings PATCH, like `applyScale`.
 *
 * No restore is needed in `afterEach`: `audio.rail_target` **is** part of the
 * bench's `CANONICAL_SETTINGS`, so `/__test/reset` writes `software` back. That
 * is the difference from `ui.scale` and `ui.dashboard_columns`, which the reset
 * does not restore and which therefore need their own restore calls.
 *
 * @param request the test's API request context.
 * @param target the stage the rail's volume buttons must act on.
 */
async function applyRailTarget(
  request: APIRequestContext,
  target: 'software' | 'hardware'
): Promise<void> {
  const patch = await request.patch('/api/settings', { data: { 'audio.rail_target': target } });
  expect(patch.ok(), await patch.text()).toBe(true);
}

/**
 * Wait until the document is rendering at *step* and assert both halves of it.
 *
 * The attribute is the input (`tokens.css` turns it into `--ui-scale`) and the
 * computed `zoom` is what the renderer applies at the root, so both are
 * asserted: an attribute with no zoom rule is a stale `web/dist`, and a zoom with
 * a second factor elsewhere is the double-scaling defect. 100 is the default step
 * and must leave **no** attribute behind — `index.html` and `scale.svelte.ts` both
 * spell that out, so the base rendering path stays exactly the one that existed
 * before this setting.
 *
 * Polled, never a bare timeout: the settings arrive over a real `GET` after mount.
 *
 * @param page the page whose document element is measured.
 * @param step the step the page must be rendering at.
 */
async function expectScaleApplied(page: Page, step: ScaleStep): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          scaleAttr: document.documentElement.dataset.uiScale ?? null,
          // Rounded because the browser serialises `zoom`, and the step's own
          // arithmetic (`step / 100`) has to compare equal to it.
          zoom:
            Math.round(parseFloat(getComputedStyle(document.documentElement).zoom) * 1000) / 1000
        })),
      { message: `ui.scale ${step} must be one root zoom on <html> (${step / 100}x)` }
    )
    .toEqual({ scaleAttr: step === 100 ? null : String(step), zoom: step / 100 });
}

/**
 * Store *step*, mount the dashboard with *count* tiles at *viewport* and wait
 * until the document renders at that step.
 *
 * `openWithTiles` is left exactly as it was on purpose: the fill tests above
 * depend on its behaviour, and the scale is a separate axis, not a second thing
 * every one of them should start doing.
 *
 * @param page the page to drive.
 * @param request the test's API request context.
 * @param count how many tiles the dashboard must show.
 * @param viewport the panel size to measure at.
 * @param step the `ui.scale` step the page must render at.
 */
async function openWithScale(
  page: Page,
  request: APIRequestContext,
  count: number,
  viewport: { readonly width: number; readonly height: number },
  step: ScaleStep
): Promise<void> {
  await applyScale(request, step);
  await openWithTiles(page, request, count, viewport);
  await expectScaleApplied(page, step);
}

/** The rendered sizes `ui.scale` is measured with, collected in one evaluation. */
interface RenderedGeometry {
  /** The first tile's border box, as painted. */
  readonly tile: BoxRect;
  /** The `Range` advance width of the first tile's `.state .word` text. */
  readonly tileWordWidth: number;
  /** The `Range` advance width of the first tile's `.name` text. */
  readonly tileNameWidth: number;
  /** The first tile's `.icon svg` box. */
  readonly tileIcon: BoxRect;
  /** Whether the first tile's `.card` keeps its own content inside itself. */
  readonly cardFits: boolean;
  /**
   * The rail's own **border box**: the fixed column (D28) those controls sit in.
   *
   * This is what the file used to spend on a caption pill's *width*, and its
   * width is now the size assertion itself: 112 layout px at 100% and at 130%
   * (80 of `--rail-control` plus two 16px `--gap` gutters, cd-bdjz), i.e. 145.6
   * **rendered** px at 130%, because the column is a token sum rather than a
   * viewport share.
   */
  readonly rail: BoxRect | null;
  readonly railButton: BoxRect | null;
  readonly docScrollHeight: number;
  readonly docClientHeight: number;
  readonly docScrollWidth: number;
  readonly docClientWidth: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scaleAttr: string | null;
  readonly zoom: string;
}

/**
 * Read the rendered sizes once.
 *
 * Rects and `Range` widths, never `getComputedStyle().fontSize`: a computed font
 * size is reported *before* the root `zoom`, so a 130% panel would report the
 * same 16px as a 100% one. `getBoundingClientRect()` is post-zoom, which is what
 * the owner sees. Text is measured as a `Range` advance width around the
 * element's contents — a width is linear in the font size, while a line-box
 * height carries the line-height multiplier and far more rounding noise.
 *
 * A missing selector throws with its own name instead of defaulting to a zero: a
 * zero would read as "the text collapsed", which is a different finding from
 * "the tile no longer has that element".
 *
 * @param page the page showing the dashboard.
 */
async function measureRendered(page: Page): Promise<RenderedGeometry> {
  return page.evaluate((): RenderedGeometry => {
    function boxOf(element: Element): BoxRect {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    }

    /** The advance width of *element*'s text, or a failure naming it. */
    function advanceOf(element: Element | null, what: string): number {
      if (element === null) {
        throw new Error(`the dashboard has no ${what} to measure`);
      }
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().width;
    }

    const tile = document.querySelector('ul.tiles li.tile');
    if (tile === null) {
      throw new Error('the dashboard has no tile to measure');
    }
    const icon = tile.querySelector('.icon svg');
    if (icon === null) {
      throw new Error('the first tile must have an .icon svg (not a custom icon) to measure');
    }
    const card = tile.querySelector('.card');
    if (card === null) {
      throw new Error('the first tile must have a .card');
    }

    const rail = document.querySelector('[data-testid="control-rail"]');
    const railButton = rail === null ? null : rail.querySelector('button');
    const scrolling = document.scrollingElement ?? document.documentElement;

    return {
      tile: boxOf(tile),
      tileWordWidth: advanceOf(tile.querySelector('.state .word'), 'first tile .state .word'),
      tileNameWidth: advanceOf(tile.querySelector('.name'), 'first tile .name'),
      tileIcon: boxOf(icon),
      cardFits:
        card.scrollHeight <= card.clientHeight + 1 && card.scrollWidth <= card.clientWidth + 1,
      rail: rail === null ? null : boxOf(rail),
      railButton: railButton === null ? null : boxOf(railButton),
      docScrollHeight: scrolling.scrollHeight,
      docClientHeight: scrolling.clientHeight,
      docScrollWidth: scrolling.scrollWidth,
      docClientWidth: scrolling.clientWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scaleAttr: document.documentElement.dataset.uiScale ?? null,
      zoom: getComputedStyle(document.documentElement).zoom
    };
  });
}

/**
 * The control rail's own box and its overflow metrics.
 *
 * The painted text is read by the shared `visibleTextsUnder` helper in
 * `fixtures.ts`, which lists it rather than reporting a boolean so a failure
 * names the text that should not be there. Both scroll metrics are collected
 * because the rail is a fixed column: it can overflow vertically (too many
 * controls for the panel) as easily as horizontally, and only one of those would
 * show up in a screenshot.
 */
interface RailGeometry {
  /** The rail's **border box**: the fixed column itself. */
  readonly rail: BoxRect;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  /** The clipped stage sentence, whitespace-collapsed. */
  readonly stageText: string;
}

/** Every tile's and every `.card`'s painted box, plus the content scroller. */
interface RowFloorGeometry {
  readonly tiles: readonly BoxRect[];
  readonly cards: readonly BoxRect[];
  /** Whether each card keeps its own content inside itself, index-aligned. */
  readonly cardFits: readonly boolean[];
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Read every tile and every `.card` in one evaluation.
 *
 * `measureRendered` reads the *first* tile, which is what the type and D30
 * assertions need; the row-floor contract is about *every* tile, because one
 * collapsed row is enough to let a card paint over its neighbour. The cards are
 * needed separately: `.tile` is the grid item and `.card` is the surface inside
 * it, so "the row collapsed" shows up as a card taller than the tile that holds
 * it — the defect `minmax(var(--tap-primary), 1fr)` removes.
 *
 * @param page the page showing the dashboard.
 */
async function measureRowFloor(page: Page): Promise<RowFloorGeometry> {
  return page.evaluate((): RowFloorGeometry => {
    function boxOf(element: Element): BoxRect {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    }

    const tiles = Array.from(document.querySelectorAll('ul.tiles li.tile'));
    if (tiles.length === 0) {
      throw new Error('the dashboard has no tiles to measure');
    }
    const cards = tiles.map((tile) => {
      const card = tile.querySelector('.card');
      if (card === null) {
        throw new Error('every tile must have a .card');
      }
      return card;
    });
    const content = document.querySelector('.content');
    if (content === null) {
      throw new Error('the dashboard has no .content area');
    }

    return {
      tiles: tiles.map(boxOf),
      cards: cards.map(boxOf),
      cardFits: cards.map(
        (card) => card.scrollHeight <= card.clientHeight + 1 && card.scrollWidth <= card.clientWidth + 1
      ),
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight
    };
  });
}

/**
 * The `--tap-primary` floor as it *renders* at a step.
 *
 * `tokens.css` defines it as `max(56px, calc(56px / var(--ui-scale) + 0.5px))`
 * layout px, so it paints 56 + ε at 85% and 56 × factor at 115% and above; one
 * formula covers both regimes. The half-pixel in the token is Chromium 1/64px
 * rounding headroom, which the extra 1px of slack in the assertions covers.
 *
 * @param factor the step's multiplier (`1.3` at 130%).
 */
function renderedTapFloor(factor: number): number {
  return 56 * Math.max(1, factor);
}

/**
 * Whether two boxes overlap by more than a rounding pixel on both axes.
 *
 * @param a one painted box.
 * @param b another painted box.
 */
function overlapOf(a: BoxRect, b: BoxRect): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

/**
 * The first tile's name, as the browser paints it: the computed `font-size`
 * (which the browser reports *without* the root zoom) times that zoom.
 *
 * The `Range` width in `measureRendered` proves the paint moved; it cannot say
 * the size in px, because an advance width depends on the glyphs. This is the
 * glyph-independent half: the value the tile's `max(16px, …)` floor resolves to,
 * and the root zoom as a separate computed number. Neither factor is inferred
 * from a rect, and the product is exactly the rendered em size.
 *
 * @param page the page showing the dashboard.
 */
async function nameEmSize(page: Page): Promise<number> {
  return page.evaluate(() => {
    const name = document.querySelector('ul.tiles li.tile .name');
    if (name === null) {
      throw new Error('the first tile has no .name');
    }
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    return parseFloat(getComputedStyle(name).fontSize) * zoom;
  });
}

/**
 * `measureFill`, corrected for a root `zoom`.
 *
 * `measureFill` composes the padding-inset content box out of a rendered
 * `getBoundingClientRect()` and a **computed** `padding` — and a computed length
 * is reported before the root `zoom`. At 100% the two agree exactly; at 85% the
 * inset lands 7.2px too far in (48 × 0.85 = 40.8 rendered against a computed
 * 48), so tiles that are correctly placed read as "outside the content box".
 * The original helper keeps its behaviour for the fill tests written against it;
 * the scale tests re-derive the inset with the padding multiplied by the zoom.
 *
 * @param page the page showing the dashboard.
 */
async function measureScaledFill(page: Page): Promise<FillGeometry> {
  const geometry = await measureFill(page);
  const zoom = await page.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1
  );
  if (zoom === 1) {
    return geometry;
  }

  // The differences are the computed paddings, unzoomed: scaling them by the
  // same zoom the rects already carry puts both in the same coordinate space.
  const border = geometry.contentBorder;
  const content = geometry.content;
  const left = border.left + (content.left - border.left) * zoom;
  const right = border.right - (border.right - content.right) * zoom;
  const top = border.top + (content.top - border.top) * zoom;
  const bottom = border.bottom - (border.bottom - content.bottom) * zoom;
  return {
    ...geometry,
    content: { left, right, top, bottom, width: right - left, height: bottom - top }
  };
}

/** The most of `.content`'s element the tiles could cover, past its own padding. */
function reachableShareOf(geometry: FillGeometry): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: geometry.content.width / geometry.contentBorder.width,
    height: geometry.content.height / geometry.contentBorder.height
  };
}

/**
 * AC 5's criterion, literally: at every step the tile union covers at least 90%
 * of `.content`'s **content box**, on each axis.
 *
 * The content box — the padding-inset area the grid is handed — is the box AC 5
 * names, so it is the box asserted here: measured across the panels AC 4 names
 * this reaches 100% at every step, because the grid fills the box it is given
 * and `ui.scale` only changes how much box the panel inset leaves (see the
 * recorded border-box shares by the scale matrix below). The **border** box is a
 * different, stricter question — HSD-enxf's, answered by `borderCoverageOf` —
 * but it is no longer a test of the padding either: since cd-bdjz the px inset
 * is one `--gap` plus the derived rail column, 128 layout px, which costs at
 * most 2.2% of the border box's width (measured 98.8% at 85% through 97.8% at
 * 150% on a 1280x720 panel), so the caller's `reachable` guard in
 * `expectDashboardInsidePanel` now takes HSD-enxf's 90% line at every step of
 * the scale matrix, not only at the small ones. The content box is still the
 * box asserted here unconditionally, and the border box is still never
 * substituted for it.
 *
 * @param geometry the measured, zoom-corrected fill geometry.
 * @param detail the failure message, carrying the measurement.
 */
function expectPanelCoverage(geometry: FillGeometry, detail: string): void {
  const union = unionOf(geometry.tiles);
  const axes = [
    { axis: 'width', covered: union.width, box: geometry.content.width },
    { axis: 'height', covered: union.height, box: geometry.content.height }
  ] as const;

  for (const { axis, covered, box } of axes) {
    const share = covered / box;
    expect(
      share,
      `the tiles do not cover 90% of the content box's ${axis}: ` +
        `${(share * 100).toFixed(1)}% (${covered.toFixed(1)} of ${box.toFixed(1)}px) — ${detail}`
    ).toBeGreaterThanOrEqual(0.9);
  }
}

/**
 * The panel's own frame: no document overflow, and the D28 rail on screen with
 * no tile underneath it.
 *
 * @param geometry the measured fill geometry.
 * @param rendered the measured rendered sizes for the same page.
 * @param detail the failure message, carrying the step, the panel and the numbers.
 */
function expectPanelFrame(
  geometry: FillGeometry,
  rendered: RenderedGeometry,
  detail: string
): void {
  // `zoom` does not scale viewport units, so `--viewport-height` is divided back
  // once in `tokens.css`. Forgetting that shows up here as a shell taller than
  // the panel, i.e. a document that scrolls.
  expect(
    rendered.docScrollHeight,
    `the document scrolls vertically (scrollHeight ${rendered.docScrollHeight} vs ` +
      `clientHeight ${rendered.docClientHeight}): a shell is taller than the panel — ${detail}`
  ).toBeLessThanOrEqual(rendered.docClientHeight + 1);
  expect(
    rendered.docScrollWidth,
    `the document scrolls horizontally (scrollWidth ${rendered.docScrollWidth} vs ` +
      `clientWidth ${rendered.docClientWidth}) — ${detail}`
  ).toBeLessThanOrEqual(rendered.docClientWidth + 1);

  const rail = rendered.rail;
  if (rail === null) {
    throw new Error(`the dashboard has no control rail — ${detail}`);
  }
  expect(rail.left, `the rail starts left of the viewport — ${detail}`).toBeGreaterThanOrEqual(-1);
  expect(rail.right, `the rail runs past the viewport edge — ${detail}`).toBeLessThanOrEqual(
    rendered.innerWidth + 1
  );
  expect(rail.top, `the rail starts above the viewport — ${detail}`).toBeGreaterThanOrEqual(-1);
  expect(rail.bottom, `the rail runs past the viewport bottom — ${detail}`).toBeLessThanOrEqual(
    rendered.innerHeight + 1
  );

  // D28: the rail is the dashboard's right-hand column, so "does not overlap" is
  // "every tile ends at or before the rail's left edge". A right edge that
  // merely reaches `rail.left` is the boundary case, so this is not relaxed.
  expect(
    Math.max(...geometry.tiles.map((tile) => tile.right)),
    `a tile runs under the control rail (tile right vs rail left ${rail.left.toFixed(1)}) — ${detail}`
  ).toBeLessThanOrEqual(rail.left + 1);
}

/**
 * Everything AC 5 asks of one panel under one step: the fill contract, the frame,
 * the content area's safety scroller idle, and a tile that does not clip itself.
 *
 * @param geometry the measured fill geometry.
 * @param rendered the measured rendered sizes for the same page.
 * @param detail the failure message, carrying the step, the panel and the numbers.
 */
function expectDashboardInsidePanel(
  geometry: FillGeometry,
  rendered: RenderedGeometry,
  detail: string
): void {
  expectTilesFillContent(geometry, detail);

  // The HSD-enxf line (90% of the *border* box) is asserted wherever the
  // one-factor inset actually leaves 90% to cover — its arithmetic is recorded
  // by the scale matrix. AC 5's own box is the content box, and that is
  // `expectPanelCoverage`, asserted at every step without exception.
  const reachable = reachableShareOf(geometry);
  if (reachable.width >= 0.9 && reachable.height >= 0.9) {
    expectTilesCoverContentBox(geometry, detail);
  }
  expectPanelCoverage(geometry, detail);
  expectPanelFrame(geometry, rendered, detail);

  // The safety valve exists for a pathological tile count, never for a step.
  expect(
    geometry.scrollHeight,
    `the content area's safety scroller is engaged (scrollHeight ${geometry.scrollHeight} vs ` +
      `clientHeight ${geometry.clientHeight}) — ${detail}`
  ).toBeLessThanOrEqual(geometry.clientHeight + 1);

  // A tile that clips its own `.card` has moved the zoom into the type without
  // giving the box the room for it.
  expect(rendered.cardFits, `the first tile clips its own card — ${detail}`).toBe(true);
}

/**
 * Whether the grid can still fit three tracks: `TRACK_FLOOR` and `--gap` are px
 * chrome, so they move by the one factor while the panel keeps its rendered
 * size, and a step therefore fits fewer tracks. 752 layout px of grid — three
 * 240px tracks and the two 16px gutters between them — is the line; the rendered
 * content width is divided back by the factor before comparing.
 *
 * @param geometry the measured fill geometry.
 * @param factor the step's multiplier (`1.3` at 130%).
 */
function fitsThreeTracks(geometry: FillGeometry, factor: number): boolean {
  return geometry.content.width / factor >= 3 * TRACK_FLOOR + 2 * 16;
}


/** The rendered border box of a locator. */
async function renderedBoxOf(locator: Locator): Promise<BoxRect> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  });
}

/**
 * Tab until *locator* is the focused element, at most *limit* presses.
 *
 * A bounded loop rather than `locator.focus()`: the point of the 130% keyboard
 * case is a `:focus-visible` ring painted on a control that was reached with the
 * keyboard. The bound keeps a changed tab order from hanging the run.
 *
 * @param page the page to drive.
 * @param locator the element that must end up focused.
 * @param limit the maximum number of Tab presses.
 * @returns whether Tab reached it within the bound.
 */
async function tabToFocused(page: Page, locator: Locator, limit: number): Promise<boolean> {
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return true;
    }
  }
  return false;
}

/** An open picker sheet's geometry, as the browser paints it. */
interface SheetGeometry {
  readonly rect: BoxRect;
  readonly rowHeights: readonly number[];
  readonly rowOverflow: readonly string[];
  /** Each text node's rendered em size (computed font size × the root zoom). */
  readonly textSizes: readonly number[];
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/**
 * Measure the open picker sheet once.
 *
 * The text sizes are `font-size × root zoom`, not a `Range` width: the assertion
 * is an absolute px floor, and an advance width would make it depend on the
 * glyphs in the row. `zoom` is not included in the computed font size, so the
 * product is the only glyph-free way to say "this text paints at 23.3px".
 *
 * @param page the page showing the open sheet.
 */
async function measureSheet(page: Page): Promise<SheetGeometry> {
  return page.evaluate((): SheetGeometry => {
    const dialog = document.querySelector('dialog.sheet[open]');
    if (dialog === null) {
      throw new Error('no open sheet to measure');
    }
    const rect = dialog.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const rows = Array.from(dialog.querySelectorAll('.options label.row'));
    if (rows.length === 0) {
      throw new Error('the open sheet has no option rows');
    }

    const rowOverflow: string[] = [];
    rows.forEach((row, index) => {
      if (row.scrollHeight > row.clientHeight + 1 || row.scrollWidth > row.clientWidth + 1) {
        rowOverflow.push(
          `row ${index}: scroll ${row.scrollHeight}x${row.scrollWidth} vs client ` +
            `${row.clientHeight}x${row.clientWidth}`
        );
      }
    });

    const textSizes = [
      dialog.querySelector('.sheet-title'),
      ...rows.map((row) => row.querySelector('.row-label'))
    ].map((element) => {
      if (element === null) {
        throw new Error('every open sheet row must have a .row-label');
      }
      return parseFloat(getComputedStyle(element).fontSize) * zoom;
    });

    const scrolling = document.scrollingElement ?? document.documentElement;
    return {
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      rowHeights: rows.map((row) => row.getBoundingClientRect().height),
      rowOverflow,
      textSizes,
      scrollWidth: scrolling.scrollWidth,
      clientWidth: scrolling.clientWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    };
  });
}

test('the tiles fill the content box at 1, 2 and 4 tiles', async ({ page, request }) => {
  for (const viewport of VIEWPORTS) {
    for (const count of [1, 2, 4] as const) {
      await openWithTiles(page, request, count, viewport);

      const geometry = await measureFill(page);
      const detail = detailOf(`${count} tiles at ${viewport.width}x${viewport.height}`, geometry);

      expectTilesFillContent(geometry, detail);

      // The two touch floors (D26): a tile stretched to fill a panel is still a
      // target, so it may never be narrower than `--tap` or shorter than
      // `--tap-primary`.
      for (const tile of geometry.tiles) {
        expect(tile.width, detail).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
        expect(tile.height, detail).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT);
      }

      // The safety valve exists for a pathological count, never for these: a
      // scrolled content area would mean some rows are off-screen.
      expect(geometry.scrollHeight, detail).toBeLessThanOrEqual(geometry.clientHeight + 1);
      expect(geometry.scrollTop, detail).toBe(0);
    }
  }

  watch.assertAllLocal();
});

test('nine tiles fit the smallest panel without the safety scroller', async ({ page, request }) => {
  await openWithTiles(page, request, 9, SMALLEST);

  const geometry = await measureFill(page);
  const detail = detailOf(`9 tiles at ${SMALLEST.width}x${SMALLEST.height}`, geometry);

  // The ticket's explicit case. `.content` has a hidden `overflow-y: auto`
  // scroller as a fallback; at 9 tiles on the smallest panel it must not scroll,
  // or the last row is off-screen on the reference panel.
  expect(geometry.scrollHeight, detail).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(geometry.scrollTop, detail).toBe(0);
  expectTilesFillContent(geometry, detail);

  for (const tile of geometry.tiles) {
    expect(tile.height, detail).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT);
  }

  watch.assertAllLocal();
});

test('nine tiles fill every supported resolution', async ({ page, request }) => {
  // The smallest panel is the previous test's case; these are the other three.
  for (const viewport of VIEWPORTS.slice(1)) {
    await openWithTiles(page, request, 9, viewport);

    const geometry = await measureFill(page);
    const detail = detailOf(`9 tiles at ${viewport.width}x${viewport.height}`, geometry);

    expectTilesFillContent(geometry, detail);
    for (const tile of geometry.tiles) {
      expect(tile.height, detail).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT);
    }
    expect(geometry.scrollHeight, detail).toBeLessThanOrEqual(geometry.clientHeight + 1);
    expect(geometry.scrollTop, detail).toBe(0);
  }

  watch.assertAllLocal();
});

test('two tiles cover the content box in both axes at the panel resolution', async ({
  page,
  request
}) => {
  // HSD-enxf's headline defect: HSD-n3nr gave the tiles their vertical space and
  // left the horizontal one to a `min(100%, 1120px)` centring column, so two
  // tiles on the owner's own 1280×720 panel were tall and narrow with an empty
  // margin down each side. Measured against `.content`'s border box, because
  // that is the space the owner sees; the inset box would hide the margin inside
  // the padding. An axis-wise ratio catches it, which an area-only ratio can miss
  // on a wide-and-short union.
  await openWithTiles(page, request, 2, PANEL);

  const geometry = await measureFill(page);
  const detail = detailOf(`2 tiles at ${PANEL.width}x${PANEL.height}`, geometry);

  expectTilesCoverContentBox(geometry, detail);

  watch.assertAllLocal();
});

test('one tile covers the content box in both axes at the panel resolution', async ({
  page,
  request
}) => {
  // The dramatic end of the same contract: a lone tile must own the panel, not
  // sit in the middle of it at its two-tile size. A grid that still resolves to
  // two tracks with one tile in the first reports a width share near 50% here.
  await openWithTiles(page, request, 1, PANEL);

  const geometry = await measureFill(page);
  const detail = detailOf(`1 tile at ${PANEL.width}x${PANEL.height}`, geometry);

  expectTilesCoverContentBox(geometry, detail);

  watch.assertAllLocal();
});

test('nine tiles fit the smallest panel without overflow or a safety scroller', async ({
  page,
  request
}) => {
  // The horizontal fix must not cost the smallest panel a row. Nine tiles at
  // 1024×600 is the tightest supported case, and the two failures this catches
  // are a grid that grows past `.content` — the hidden scroller then puts the
  // last row off-screen — and a tile wide enough to run under the D28 rail, which
  // would put a control surface on top of a tap target.
  await openWithTiles(page, request, 9, SMALLEST);

  const geometry = await measureFill(page);
  const detail = detailOf(`9 tiles at ${SMALLEST.width}x${SMALLEST.height}`, geometry);
  const rail = geometry.rail;
  if (rail === null) {
    throw new Error(`the dashboard has no control rail — ${detail}`);
  }

  for (const tile of geometry.tiles) {
    // Inside the content box on all four edges, to a rounding pixel.
    expect(tile.left, detail).toBeGreaterThanOrEqual(geometry.contentBorder.left - 1);
    expect(tile.top, detail).toBeGreaterThanOrEqual(geometry.contentBorder.top - 1);
    expect(tile.right, detail).toBeLessThanOrEqual(geometry.contentBorder.right + 1);
    expect(tile.bottom, detail).toBeLessThanOrEqual(geometry.contentBorder.bottom + 1);

    // The two touch floors (D26) survive the shrink to nine tiles.
    expect(tile.width, detail).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
    expect(tile.height, detail).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT);

    // D28: the rail is the dashboard's only control surface, so nothing is
    // painted under it. A right edge that merely reaches `rail.left` is already
    // the boundary case, so the comparison is not relaxed by a pixel.
    expect(tile.right, `a tile reaches the control rail — ${detail}`).toBeLessThanOrEqual(
      rail.left
    );
  }

  expect(geometry.scrollHeight, detail).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(geometry.scrollTop, detail).toBe(0);

  watch.assertAllLocal();
});

test('tile internals scale with the tile, not the viewport', async ({ page, request }) => {
  const viewport = { width: 1280, height: 720 };

  // Two tiles share the width, nine split it three ways: the same viewport, a
  // different tile. Fixed pixel sizing would report identical font sizes for
  // both, which is exactly the defect this test exists for.
  await openWithTiles(page, request, 2, viewport);
  const wide = await measureInternals(page);

  await openWithTiles(page, request, 9, viewport);
  const narrow = await measureInternals(page);

  const detail = `1280x720, 2 tiles ${JSON.stringify(wide)}, 9 tiles ${JSON.stringify(narrow)}`;

  // Every internal shrinks, and by at least 15%: a token that merely follows
  // the viewport would shrink by nothing at all.
  for (const key of ['word', 'name', 'iconWidth', 'iconHeight'] as const) {
    expect(narrow[key], `${key} must shrink: ${detail}`).toBeLessThan(wide[key]);
    expect(
      wide[key],
      `${key} must be at least 15% larger at 2 tiles: ${detail}`
    ).toBeGreaterThanOrEqual(narrow[key] * 1.15);
  }

  // And the same tile count on a larger panel is still strictly larger. The
  // margin is a couple of px: since HSD-enxf the shell is uncapped, so the wider
  // panel really does widen each of the two tiles, and the tile's own `clamp()`
  // ceilings still leave room above what two tiles reach at either size — so the
  // tolerance is half a pixel, not a whole one.
  await openWithTiles(page, request, 2, SMALLEST);
  const small = await measureInternals(page);

  await openWithTiles(page, request, 2, { width: 1920, height: 1080 });
  const large = await measureInternals(page);

  const panelDetail =
    `2 tiles, 1024x600 ${JSON.stringify(small)}, ` +
    `1920x1080 ${JSON.stringify(large)}`;
  for (const key of ['word', 'name', 'iconWidth', 'iconHeight'] as const) {
    expect(large[key], `${key} must be larger on the larger panel: ${panelDetail}`).toBeGreaterThan(
      small[key] + 0.5
    );
  }

  watch.assertAllLocal();
});

test('the icon and the state text are larger in a one-tile layout than in a nine-tile layout', async ({
  page,
  request
}) => {
  // HSD-enxf's second half. The internals used to be sized from the viewport, so
  // a one-tile and a nine-tile layout on the *same* panel rendered the same icon
  // and the same state text: the tile grew and its contents did not. Only the
  // tile's own box differs between these two runs, so only a tile-local unit can
  // make these four numbers differ at all.
  await openWithTiles(page, request, 1, PANEL);
  const lone = await measureInternals(page);

  await openWithTiles(page, request, 9, PANEL);
  const crowded = await measureInternals(page);

  const detail = `1280x720, 1 tile ${JSON.stringify(lone)}, 9 tiles ${JSON.stringify(crowded)}`;

  // The icon is drawn into a square box. If one axis were clamped by the tile's
  // width and the other by its height, "larger" could be one axis growing while
  // the other shrank — that is not scaling with the tile, it is a distortion.
  expect(
    Math.abs(lone.iconWidth - lone.iconHeight),
    `the icon box must be square at 1 tile: ${detail}`
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(crowded.iconWidth - crowded.iconHeight),
    `the icon box must be square at 9 tiles: ${detail}`
  ).toBeLessThanOrEqual(1);

  // Every internal grows with the tile, and by at least 15%: a token that merely
  // follows the viewport would report identical numbers for both.
  for (const key of ['word', 'name', 'iconWidth', 'iconHeight'] as const) {
    expect(crowded[key], `${key} must shrink with the tile: ${detail}`).toBeLessThan(lone[key]);
    expect(
      lone[key],
      `${key} must be at least 15% larger at 1 tile: ${detail}`
    ).toBeGreaterThanOrEqual(crowded[key] * 1.15);
  }

  watch.assertAllLocal();
});

test('a forced column count never produces a sliver', async ({ page, request }) => {
  /** How many distinct columns the tiles occupy. */
  function columnCount(geometry: FillGeometry): number {
    const lefts = new Set(geometry.tiles.map((tile) => Math.round(tile.left)));
    return lefts.size;
  }

  // Six columns asked for, two tiles to give: the 240px track floor wins, so
  // the tiles stay wide instead of becoming six slivers.
  const forced = await request.patch('/api/settings', { data: { 'ui.dashboard_columns': 6 } });
  expect(forced.ok(), await forced.text()).toBe(true);

  await openWithTiles(page, request, 2, SMALLEST);

  const sliverGeometry = await measureFill(page);
  const sliverDetail = detailOf(
    `2 tiles under 6 forced columns at ${SMALLEST.width}x${SMALLEST.height}`,
    sliverGeometry
  );
  expectTilesFillContent(sliverGeometry, sliverDetail);
  expect(sliverGeometry.tiles.length, sliverDetail).toBe(2);
  for (const tile of sliverGeometry.tiles) {
    expect(tile.width, sliverDetail).toBeGreaterThanOrEqual(TRACK_FLOOR);
  }
  // Same row: the two tiles differ only in their left edge.
  const rowOffset = Math.abs(sliverGeometry.tiles[0].top - sliverGeometry.tiles[1].top);
  expect(rowOffset, sliverDetail).toBeLessThanOrEqual(1);

  // The regression the gutter correction exists for: `auto-fit` counts the
  // gutters, so a track minimum of `100% / N` fits only N-1 tracks and a forced
  // 2 or 3 lost a column at every width. Each track now asks for
  // `(100% - (N-1)·gap) / N`, which is exactly N tracks.
  for (const columns of [2, 3] as const) {
    const patch = await request.patch('/api/settings', {
      data: { 'ui.dashboard_columns': columns }
    });
    expect(patch.ok(), await patch.text()).toBe(true);

    for (const viewport of [SMALLEST, VIEWPORTS[2], VIEWPORTS[3]]) {
      await openWithTiles(page, request, columns, viewport);

      const geometry = await measureFill(page);
      const detail = detailOf(
        `${columns} tiles under ${columns} forced columns at ${viewport.width}x${viewport.height}`,
        geometry
      );
      expect(columnCount(geometry), detail).toBe(columns);
      expect(geometry.tiles.length, detail).toBe(columns);
    }
  }

  // `/__test/reset` does not restore settings — the bench's `CANONICAL_SETTINGS`
  // has no `ui.dashboard_columns` — so the next test (and the next run) would
  // inherit the forced count unless this spec puts it back.
  await restoreColumns(request);

  watch.assertAllLocal();
});

test('two tiles cover the content box at every panel shape', async ({ page, request }) => {
  // The amendment's spread, not just the owner's 1280×720: the same contract is
  // measured on portrait, ultrawide and 4K, which is where a shape-dependent
  // layout (an aspect-ratio box, a fixed max-width column) gives itself away.
  for (const viewport of MATRIX) {
    await openWithTiles(page, request, 2, viewport);

    const geometry = await measureFill(page);
    const detail = detailOf(`2 tiles at ${viewport.width}x${viewport.height}`, geometry);

    expectTilesCoverContentBox(geometry, detail);

    // One line per panel shape, from the same measurement the assertion used, so
    // a run's own output is the per-viewport table: the ratios against the
    // content box's border box, plus the tile the grid actually produced.
    const share = borderCoverageOf(geometry);
    const tile = geometry.tiles[0];
    console.log(
      `2 tiles ${viewport.width}x${viewport.height}: ` +
        `width ${(share.width * 100).toFixed(1)}% ` +
        `height ${(share.height * 100).toFixed(1)}% of the content box ` +
        `(tile ${tile.width.toFixed(0)}x${tile.height.toFixed(0)})`
    );
  }

  watch.assertAllLocal();
});

test('one tile covers the content box at every panel shape', async ({ page, request }) => {
  // The dramatic end of the same contract at every shape: a lone tile owns the
  // panel. In portrait this is the case a landscape-only grid gets wrong, and on
  // the ultrawide it is the one a fixed two-track grid gets wrong.
  for (const viewport of MATRIX) {
    await openWithTiles(page, request, 1, viewport);

    const geometry = await measureFill(page);
    const detail = detailOf(`1 tile at ${viewport.width}x${viewport.height}`, geometry);

    expectTilesCoverContentBox(geometry, detail);

    // The same one-line-per-viewport report as the two-tile test, so the two
    // tables from a single run can be read side by side.
    const share = borderCoverageOf(geometry);
    const tile = geometry.tiles[0];
    console.log(
      `1 tile ${viewport.width}x${viewport.height}: ` +
        `width ${(share.width * 100).toFixed(1)}% ` +
        `height ${(share.height * 100).toFixed(1)}% of the content box ` +
        `(tile ${tile.width.toFixed(0)}x${tile.height.toFixed(0)})`
    );
  }

  watch.assertAllLocal();
});

test('the tile internals are strictly larger on a larger panel', async ({ page, request }) => {
  // Why this test exists: with the old px clamp ceilings the 1920×1080 and
  // 2560×1440 numbers were bit-identical — word 120.0, name 44.0, icon 320 —
  // because the ceiling, not the tile, decided the size. Two panels 1.8× apart in
  // area rendering the same tile is the fixed-resolution lock this amendment
  // forbids, and "larger" here means strictly larger, not "as large as allowed".
  const ladder = [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 }
  ] as const;

  const series: TileInternals[] = [];
  for (const viewport of ladder) {
    await openWithTiles(page, request, 2, viewport);
    series.push(await measureInternals(page));
  }

  const detail = ladder
    .map(
      (viewport, index) =>
        `2 tiles at ${viewport.width}x${viewport.height} ${JSON.stringify(series[index])}`
    )
    .join(', ');

  // Half a pixel, not a whole one: the point is that the curve has not gone flat,
  // and a ceiling that has started to bind shows up as a sub-pixel step first.
  for (const key of ['word', 'name', 'iconWidth', 'iconHeight'] as const) {
    for (let index = 1; index < series.length; index += 1) {
      const previous = ladder[index - 1];
      const current = ladder[index];
      expect(
        series[index][key],
        `${key} must grow by more than 0.5px from ${previous.width}x${previous.height} ` +
          `to ${current.width}x${current.height}: ${detail}`
      ).toBeGreaterThan(series[index - 1][key] + 0.5);
    }
  }

  watch.assertAllLocal();
});

test('a tile never clips its own content at 4K', async ({ page, request }) => {
  // Why this test exists: the internals now have no px ceiling, so removing the
  // ceilings needs a guard proving they did not turn the tile into a clipping
  // box instead. The existing kiosk spec only sweeps 4K at nine tiles, where the
  // old ceiling never bound; one, two and four tiles are the shapes where the
  // tile is large enough that uncapped type could overflow it.
  const viewport = { width: 3840, height: 2160 };

  for (const count of [1, 2, 4] as const) {
    await openWithTiles(page, request, count, viewport);

    const clipping = await page.evaluate((): readonly string[] => {
      const offenders: string[] = [];
      const cards = Array.from(document.querySelectorAll('ul.tiles li.tile .card'));
      cards.forEach((card, index) => {
        const tall = card.scrollHeight > card.clientHeight + 1;
        const wide = card.scrollWidth > card.clientWidth + 1;
        if (tall || wide) {
          offenders.push(
            `card ${index}: scrollHeight ${card.scrollHeight} vs clientHeight ${card.clientHeight}, ` +
              `scrollWidth ${card.scrollWidth} vs clientWidth ${card.clientWidth}`
          );
        }
      });
      return offenders;
    });

    expect(
      clipping,
      `${count} tiles at ${viewport.width}x${viewport.height}: a card overflows its own box ` +
        `(the tile is clipping its content) — ${JSON.stringify(clipping)}`
    ).toEqual([]);
  }

  watch.assertAllLocal();
});

test('ui.scale keeps the dashboard inside the panel at every step', async ({ page, request }) => {
  // Fifteen panel loads in one test: the concern is "does one step break the
  // panel", and a per-cell test would repeat the same setup fifteen times and
  // push the whole tier's `globalTimeout` (300s) for no extra evidence. The
  // budget is still bounded, and each cell's failure names its own step.
  test.setTimeout(120_000);

  // What AC 5 asserts is the **content box**, and `expectPanelCoverage` asserts
  // it literally at every step (100% at every cell, since the grid fills the
  // box it is handed). The **border**-box share is recorded and printed as
  // well, and since cd-bdjz it is also asserted: the inset is one `--gap` plus
  // the derived 112px rail column — 128 layout px — not a viewport clamp, so
  // `ui.scale` moves it by the one factor while the panel keeps its rendered
  // size, and the tiles reach 98.8 / 98.6 / 98.4 / 98.2 / 97.8 % of the border
  // box's width at 85 / 100 / 115 / 130 / 150 % on a 1280x720 panel (108.8 /
  // 128 / 147.2 / 166.4 / 192 px of total horizontal inset), which clears
  // HSD-enxf's 90% line at every step through `expectDashboardInsidePanel`'s
  // reachable-share guard.
  //
  // The height share is the axis that actually varies — 95.8 / 95.0 / 94.1 /
  // 92.5 / 90.9 % at the same five steps — because the header wraps to a second
  // row at 130% and the 16px block padding is px chrome like everything else,
  // and 90.9% at 150% is the tightest cell on the matrix. The figures are
  // printed so a reader can see them without a re-run.

  for (const step of SCALE_STEPS) {
    for (const viewport of SCALE_VIEWPORTS) {
      await openWithScale(page, request, 4, viewport, step);

      const geometry = await measureScaledFill(page);
      const rendered = await measureRendered(page);
      const detail =
        `ui.scale ${step} at ${viewport.width}x${viewport.height}: ` +
        `coverage ${coverageOf(geometry).toFixed(4)}, ${JSON.stringify(rendered)}`;

      expectDashboardInsidePanel(geometry, rendered, detail);

      // One line per cell, so a run's own output is the step × panel table:
      // AC 5's content-box shares (asserted above), the border-box shares
      // (recorded, not asserted — see the note above this loop) and the tile.
      const share = borderCoverageOf(geometry);
      const union = unionOf(geometry.tiles);
      console.log(
        `ui.scale ${step} ${viewport.width}x${viewport.height}: ` +
          `content box ${((union.width / geometry.content.width) * 100).toFixed(1)}%x` +
          `${((union.height / geometry.content.height) * 100).toFixed(1)}% ` +
          `(border box ${(share.width * 100).toFixed(1)}%x${(share.height * 100).toFixed(1)}%) ` +
          `(tile ${rendered.tile.width.toFixed(0)}x${rendered.tile.height.toFixed(0)}, ` +
          `word ${rendered.tileWordWidth.toFixed(1)})`
      );
    }
  }

  watch.assertAllLocal();
});

test('ui.scale keeps nine tiles inside the panel while the grid holds nine', async ({
  page,
  request
}) => {
  // Nine tiles is the tightest arrangement, and the step that shrinks the
  // interface is where a px floor (16/20/32px in the tile's own `max()`, and the
  // 240px track floor) can outgrow the box that holds it.
  //
  // Measured, and therefore asserted in two branches: above 100% on the 1024
  // wall panel — and at 150% on 1280×720 — the 240px track floor (px chrome, so
  // it moves by the one factor) only fits **two** columns, so nine tiles become
  // five rows and the tile box is 73.3px tall at 115% and 72.8px at 130% and
  // 84.0px at 150% (rows held up by `grid-auto-rows: minmax(--tap-primary, 1fr)`,
  // which engages `.content`'s scroller there: 358px of rows in a 302px box at
  // 130%, 358 in 176 at 150%). The full nine-tile fill contract cannot hold
  // there; what must hold is that the panel is still contained and that the
  // reflow is exactly the track floor's doing. That limit is recorded here rather
  // than asserted away, so a later fix (re-flooring the track under `ui.scale`)
  // makes this test fail and be re-measured instead of drifting silently.
  test.setTimeout(120_000);

  for (const step of SCALE_STEPS) {
    for (const viewport of [PANEL, SMALLEST] as const) {
      await openWithScale(page, request, 9, viewport, step);

      const geometry = await measureScaledFill(page);
      const rendered = await measureRendered(page);
      const factor = step / 100;
      const detail =
        `ui.scale ${step} at ${viewport.width}x${viewport.height}, 9 tiles: ` +
        `coverage ${coverageOf(geometry).toFixed(4)}, ${JSON.stringify(rendered)}`;
      const columns = new Set(geometry.tiles.map((tile) => Math.round(tile.left))).size;

      expectPanelFrame(geometry, rendered, detail);
      expect(geometry.tiles.length, detail).toBe(9);

      if (fitsThreeTracks(geometry, factor)) {
        expect(columns, `the grid must use three tracks — ${detail}`).toBe(3);
        expectDashboardInsidePanel(geometry, rendered, detail);

        // The rendered text itself: a `Range` over a text node that is missing or
        // collapsed reports 0, and a tile whose type did not render at all would
        // still pass every fill assertion above.
        expect(Number.isFinite(rendered.tileWordWidth) && rendered.tileWordWidth > 0, detail).toBe(
          true
        );
        expect(Number.isFinite(rendered.tileNameWidth) && rendered.tileNameWidth > 0, detail).toBe(
          true
        );
      } else {
        // The measured reflow: two tracks, and every tile still inside the
        // content box horizontally. The tile's height is reported, not asserted
        // here — the row floor has its own contract in
        // `the grid never collapses a row below the D26 tap floor`. Recorded:
        // 73.3px at 115%, 72.8px at 130% and 84.0px at 150% on 1024×600 (54.3
        // and 25.0 before the row floor existed), with the content scroller
        // engaged at 130% and 150% and idle at 115%.
        expect(columns, `the grid must fall back to two tracks — ${detail}`).toBe(2);
        for (const tile of geometry.tiles) {
          expect(tile.left, detail).toBeGreaterThanOrEqual(geometry.content.left - 1);
          expect(tile.right, detail).toBeLessThanOrEqual(geometry.content.right + 1);
        }
      }

      console.log(
        `9 tiles at ${step}% ${viewport.width}x${viewport.height}: ${columns} columns, ` +
          `tile ${geometry.tiles[0].width.toFixed(0)}x${geometry.tiles[0].height.toFixed(0)}, ` +
          `cardFits ${rendered.cardFits}, grid ` +
          `${(geometry.content.width / factor).toFixed(0)}px of layout width ` +
          `(${fitsThreeTracks(geometry, factor) ? 'three tracks fit' : 'only two tracks fit'})`
      );
    }
  }

  watch.assertAllLocal();
});

test('the grid never collapses a row below the D26 tap floor', async ({ page, request }) => {
  // The contract behind `grid-auto-rows: minmax(var(--tap-primary), 1fr)`. `1fr`
  // alone is `minmax(auto, 1fr)` and `.tile` sets `min-height: 0`, so a grid that
  // needs more rows than the panel has height for used to shrink each row below
  // the tap floor — and because `.card` keeps `min-height: var(--tap-primary)`,
  // the card then overflowed its own tile onto the next row. Measured on the
  // unfixed CSS at 9 tiles on 1024×600: 54.3px tiles at 130% and 25.0px at 150%,
  // every card 56 layout px tall inside them. A collapsed row is a clip, not the
  // documented safety valve.
  //
  // So: every tile is at least the rendered floor tall, every card sits inside
  // its own tile and is at least the floor tall too, nothing overlaps, and every
  // tile is still on the page. Where the rows plus the gaps cannot fit, it is
  // `.content`'s scroller that takes the overflow: that is allowed on the
  // pathological cell and forbidden on the three panels AC 4 names.
  test.setTimeout(180_000);

  const cells: ReadonlyArray<{
    readonly label: string;
    readonly count: number;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly scrollerAllowed: boolean;
  }> = [
    { label: 'the reference panel', count: 6, viewport: SCALE_VIEWPORTS[0], scrollerAllowed: false },
    { label: '1080p', count: 6, viewport: SCALE_VIEWPORTS[1], scrollerAllowed: false },
    { label: '1440p', count: 6, viewport: SCALE_VIEWPORTS[2], scrollerAllowed: false },
    // The pathological cell: nine tiles turn into five rows once the 240px track
    // floor only fits two columns, so above 100% the rows plus gutters exceed the
    // content height and the scroller is the valve — measured engaged at 130%
    // (358 of 302px) and at 150% (358 of 176px) after this fix, and *not* at
    // 115%, where five 73.3px rows still fit (412 of 412px).
    { label: 'the 1024x600 wall panel', count: 9, viewport: SMALLEST, scrollerAllowed: true }
  ];

  for (const step of SCALE_STEPS) {
    for (const cell of cells) {
      await openWithScale(page, request, cell.count, cell.viewport, step);

      const geometry = await measureRowFloor(page);
      const factor = step / 100;
      const floor = renderedTapFloor(factor);
      const detail =
        `ui.scale ${step} at ${cell.viewport.width}x${cell.viewport.height}, ` +
        `${cell.count} tiles (${cell.label}): ${JSON.stringify(geometry)}`;

      expect(geometry.tiles.length, `a tile is missing — ${detail}`).toBe(cell.count);

      for (const [index, tile] of geometry.tiles.entries()) {
        expect(
          tile.height,
          `tile ${index} is ${tile.height.toFixed(1)}px tall, under the ${floor.toFixed(1)}px ` +
            `D26 --tap-primary floor rendered at ${step}% (the row collapsed) — ${detail}`
        ).toBeGreaterThanOrEqual(floor - 1);

        const card = geometry.cards[index];
        expect(
          card.height,
          `card ${index} is ${card.height.toFixed(1)}px tall, under the ${floor.toFixed(1)}px ` +
            `--tap-primary floor rendered at ${step}% — ${detail}`
        ).toBeGreaterThanOrEqual(floor - 1);

        // The defect the row floor removes: the card is taller than the tile
        // holding it, so it paints over the row below instead of being contained.
        expect(
          card.bottom,
          `card ${index} overflows its own tile (card ${card.top.toFixed(1)}-` +
            `${card.bottom.toFixed(1)} vs tile ${tile.top.toFixed(1)}-${tile.bottom.toFixed(1)}) — ${detail}`
        ).toBeLessThanOrEqual(tile.bottom + 1);
        expect(
          card.top,
          `card ${index} starts above its own tile (card ${card.top.toFixed(1)} vs tile ` +
            `${tile.top.toFixed(1)}) — ${detail}`
        ).toBeGreaterThanOrEqual(tile.top - 1);
      }

      // Nothing painted over anything else: a collapsed row used to make every
      // card start inside its neighbour's box.
      for (let index = 0; index < geometry.cards.length; index += 1) {
        for (let other = index + 1; other < geometry.cards.length; other += 1) {
          expect(
            overlapOf(geometry.cards[index], geometry.cards[other]),
            `cards ${index} and ${other} overlap — ${detail}`
          ).toBe(false);
          expect(
            overlapOf(geometry.tiles[index], geometry.tiles[other]),
            `tiles ${index} and ${other} overlap — ${detail}`
          ).toBe(false);
        }
      }

      // On the three AC panels the valve is forbidden: a scrolled content area
      // there would mean a row is off-screen. On the pathological cell it is the
      // valve doing its job — a row floor that binds is exactly the case it
      // exists for — so its engagement is recorded in the log below rather than
      // forbidden. Nothing is dropped (the count above) and no row is compressed
      // (the floor above), so what overflows is scrollable, not cropped.
      if (!cell.scrollerAllowed) {
        expect(
          geometry.scrollHeight,
          `the content area's safety scroller is engaged at an AC panel ` +
            `(scrollHeight ${geometry.scrollHeight} vs clientHeight ${geometry.clientHeight}) — ${detail}`
        ).toBeLessThanOrEqual(geometry.clientHeight + 1);
      }

      // One line per cell: the tile floor, the scroller and whether the cards
      // still keep their own content inside themselves. `cardFits` is printed,
      // not asserted — it compares a card's content against the card's own 100%
      // box, and the D30 px floors (`max(32px, …)`, `max(20px, …)`,
      // `max(16px, …)`) do not shrink, so at a 56px row a card needs ~68px: it
      // reads false at 9 tiles on 1024×600 above 115% (before and after this
      // fix alike) and at 150% for 6 tiles on 1280×720 (82px of content in a
      // 79px card). That is the px-floor limit, not a collapsed row.
      console.log(
        `row floor at ${step}% ${cell.viewport.width}x${cell.viewport.height} ` +
          `(${cell.count} tiles): tile ${geometry.tiles[0].height.toFixed(1)}px ` +
          `(floor ${floor.toFixed(1)}), card ` +
          `${geometry.cards[0].height.toFixed(1)}px, scroller ` +
          `${geometry.scrollHeight}/${geometry.clientHeight}, ` +
          `cardFits ${geometry.cardFits.every(Boolean)}`
      );
    }
  }

  watch.assertAllLocal();
});

test('ui.scale never shrinks a touch target below 48 px', async ({ page, request }) => {
  // AC 6, at the step where a floor implemented as a *layout* size would fail:
  // 48px × 0.85 renders 40.8px. `tokens.css` divides by `--ui-scale` first, so
  // the floor is a rendered size and this measures the paint, not the rule.
  await openWithScale(page, request, 4, PANEL, SMALLEST_SCALE);
  const floored = await measureRendered(page);
  const detail = `ui.scale ${SMALLEST_SCALE} at 1280x720: ${JSON.stringify(floored)}`;

  const button = floored.railButton;
  if (button === null) {
    throw new Error(`the control rail has no button — ${detail}`);
  }
  expect(button.width, `the rail button is narrower than --tap (48 rendered) — ${detail}`).toBeGreaterThanOrEqual(
    48
  );
  expect(button.height, `the rail button is shorter than --tap (48 rendered) — ${detail}`).toBeGreaterThanOrEqual(
    48
  );
  expect(floored.tile.width, `the tile is narrower than 48 — ${detail}`).toBeGreaterThanOrEqual(48);
  expect(floored.tile.height, `the tile is shorter than 48 — ${detail}`).toBeGreaterThanOrEqual(48);

  // And the floor is a *rendered* size, not a layout size: at 85% `--tap-primary`
  // resolves to 66.4 layout px and at 100% to 56 layout px, yet both paint 56px.
  // The 1px of slack covers Chromium's 1/64px layout snapping. A double-scaled
  // implementation would paint 56 × 0.85 = 47.6px, 8.8px below the 56.4px this
  // measures at 85%.
  await openWithScale(page, request, 4, PANEL, 100);
  const base = await measureRendered(page);
  const baseButton = base.railButton;
  if (baseButton === null) {
    throw new Error(`the control rail has no button at 100 — ${JSON.stringify(base)}`);
  }
  expect(
    Math.abs(button.height - baseButton.height),
    `the rail button's height must be the same floor at 85% and 100% ` +
      `(${button.height.toFixed(2)} vs ${baseButton.height.toFixed(2)} rendered px)`
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(button.width - baseButton.width),
    `the rail button's width must be the same floor at 85% and 100% ` +
      `(${button.width.toFixed(2)} vs ${baseButton.width.toFixed(2)} rendered px)`
  ).toBeLessThanOrEqual(1);

  // The same floors on the settings screens, where the panel's own controls are
  // the targets: the "Interface scale" picker trigger and the section's Save.
  await applyScale(request, SMALLEST_SCALE);
  await page.goto('/settings/appearance');
  await expectScaleApplied(page, SMALLEST_SCALE);

  const settingsDetail = `ui.scale ${SMALLEST_SCALE} on /settings/appearance at 1280x720`;
  const trigger = page.getByRole('button', { name: /^Interface scale/ });
  await expect(trigger, settingsDetail).toBeVisible();
  const triggerBox = await renderedBoxOf(trigger);
  expect(
    triggerBox.height,
    `the scale Select's trigger is shorter than --tap (48 rendered): ${triggerBox.height.toFixed(2)}px — ${settingsDetail}`
  ).toBeGreaterThanOrEqual(48);

  const save = page.getByRole('button', { name: 'Save appearance', exact: true });
  const saveBox = await renderedBoxOf(save);
  expect(
    saveBox.height,
    `the section's Save button is shorter than --tap-primary (56 rendered): ${saveBox.height.toFixed(2)}px — ${settingsDetail}`
  ).toBeGreaterThanOrEqual(48);

  console.log(
    `touch floors: rail button ${button.width.toFixed(1)}x${button.height.toFixed(1)} at 85% vs ` +
      `${baseButton.width.toFixed(1)}x${baseButton.height.toFixed(1)} at 100%, ` +
      `tile ${floored.tile.width.toFixed(1)}x${floored.tile.height.toFixed(1)}, ` +
      `settings trigger ${triggerBox.height.toFixed(1)}, save ${saveBox.height.toFixed(1)}`
  );

  watch.assertAllLocal();
});

test('ui.scale multiplies the interface once, not twice, and D30 stays scale-invariant', async ({
  page,
  request
}) => {
  test.setTimeout(120_000);

  // Two data points, never one, so the claim cannot be cherry-picked by tile
  // count. The bench's **default 6 tiles** at 1280×720 comes first: that is the
  // arrangement the owner measured, and with six tiles the strict height term
  // (`20cqb`) decides both the state word and the icon — the case a viewport-
  // derived size gives away most plainly. Two tiles is the second point, where
  // the width term (`17.5cqi`) decides the word instead. `wordAxis` is that
  // deciding axis per count, derived below rather than assumed.
  const cases = [
    { count: 6, wordAxis: 'height' },
    { count: 2, wordAxis: 'width' }
  ] as const;

  for (const { count, wordAxis } of cases) {
    await openWithScale(page, request, count, PANEL, 100);
    const base = await measureRendered(page);
    await openWithScale(page, request, count, PANEL, 130);
    const scaled = await measureRendered(page);

    const detail =
      `1280x720, ${count} tiles: 100% ${JSON.stringify(base)}, ` +
      `130% ${JSON.stringify(scaled)}`;

    /** The measured numbers, so every failure is diagnosable without a re-run. */
    function ratio(label: string, from: number, to: number): number {
      expect(from, `a zero denominator for ${label} — ${detail}`).not.toBe(0);
      return to / from;
    }

    if (base.railButton === null || scaled.railButton === null) {
      throw new Error(`the control rail has no button to measure — ${detail}`);
    }
    if (base.rail === null || scaled.rail === null) {
      throw new Error(`the control rail has no box to measure — ${detail}`);
    }

    // D30 invariance: the tile's internals keep their relationship to the tile's
    // own box. Each internal is a `min()` of two container terms — the state word
    // is `min(17.5cqi, 20cqb)`, the icon `min(80cqmin, 44cqb)` — so the honest
    // invariant is the internal against the axis that *decides* it, and that
    // ratio must not move at all. At 6 tiles the height decides both (a 360×299
    // tile puts `20cqb` under `17.5cqi`); at 2 tiles the width decides the word
    // and the height still decides the icon.
    //
    // The cross-axis pairings are not that invariant, and the numbers say so
    // rather than a guess: at 6 tiles word/width moves 0.5898 → 0.5224 (-11.4%)
    // and icon/width 0.3657 → 0.3239 (-11.4%), because the tile's own aspect
    // ratio changes between steps (360.0×299.2 → 340.0×250.3) — the header and the
    // panel inset are px chrome laid out inside a layout box that shrinks by the
    // same factor, and at 130% a 1280-wide panel's header wraps to a second row.
    // That is the one-factor rule working, not a scaling defect, so the
    // cross-axis shares are recorded in the log and not asserted.
    const wordShare = {
      base: base.tileWordWidth / base.tile[wordAxis],
      scaled: scaled.tileWordWidth / scaled.tile[wordAxis]
    };
    expect(
      Math.abs(wordShare.scaled / wordShare.base - 1),
      `the word's share of the tile ${wordAxis} moved from ${wordShare.base.toFixed(4)} to ` +
        `${wordShare.scaled.toFixed(4)} (a viewport-derived size would move by 1.3) — ${detail}`
    ).toBeLessThanOrEqual(0.03);

    const iconShare = {
      base: base.tileIcon.width / base.tile.height,
      scaled: scaled.tileIcon.width / scaled.tile.height
    };
    expect(
      Math.abs(iconShare.scaled / iconShare.base - 1),
      `the icon's share of the tile height moved from ${iconShare.base.toFixed(4)} to ` +
        `${iconShare.scaled.toFixed(4)} — ${detail}`
    ).toBeLessThanOrEqual(0.03);

    // The tile's own text is **not** asserted to grow by 1.3×, because it cannot:
    // the tile box is viewport-derived, and at the bench's 6 tiles the wrapped
    // header costs the tiles height, so the word advance goes *down* with the
    // step — measured 212.3px at 100% against 177.6px at 130% (0.836×, and the
    // D30 word/height share 0.7097 → 0.7096, i.e. the word followed the tile
    // exactly). What must hold is that it followed the tile and took no second
    // factor, which is what this line asserts; the "exactly one factor" half is
    // the companion floor test below (`ui.scale raises the D30 px floors by
    // exactly one factor, not two`), where a `max()` floor is what decides.
    const textRatio = ratio('tile word width', base.tileWordWidth, scaled.tileWordWidth);
    expect(
      textRatio,
      `the tile's word moved by ${textRatio.toFixed(3)}× with the zoom: it follows the tile, not ` +
        `the factor (a double-scaled implementation would show 1.30 or 1.69 here) — ${detail}`
    ).toBeLessThanOrEqual(1.1);

    // Fixed-size chrome moved by exactly one factor, because it is laid out in
    // the zoomed coordinate space and nothing multiplies it again.
    const buttonRatio = ratio(
      'rail button height',
      base.railButton.height,
      scaled.railButton.height
    );
    expect(
      buttonRatio,
      `the rail button's height moved by ${buttonRatio.toFixed(3)}×, not 1.3× ` +
        `(${base.railButton.height.toFixed(2)} -> ${scaled.railButton.height.toFixed(2)} rendered px) ` +
        `— ${detail}`
    ).toBeGreaterThanOrEqual(1.27);
    expect(
      buttonRatio,
      `the rail button's height moved by ${buttonRatio.toFixed(3)}×, not 1.3× — ${detail}`
    ).toBeLessThanOrEqual(1.33);

    const railRatio = ratio('rail column width', base.rail.width, scaled.rail.width);
    expect(
      railRatio,
      `the rail column's width moved by ${railRatio.toFixed(3)}×, not 1.3× ` +
        `(${base.rail.width.toFixed(2)} -> ${scaled.rail.width.toFixed(2)} rendered px) ` +
        `— ${detail}`
    ).toBeGreaterThanOrEqual(1.27);
    expect(
      railRatio,
      `the rail column's width moved by ${railRatio.toFixed(3)}×, not 1.3× — ${detail}`
    ).toBeLessThanOrEqual(1.33);

    // The column and the control inside it moved by the same factor: if only one
    // had moved twice, or if the column had kept a px width laid out inside the
    // zoomed space, this ratio would move. 112/80 — one rail control plus two
    // 16px gutters against that control — must stay put at every step.
    const railOfButton = {
      base: base.rail.width / base.railButton.height,
      scaled: scaled.rail.width / scaled.railButton.height
    };
    expect(
      Math.abs(railOfButton.scaled / railOfButton.base - 1),
      `the rail column's size relative to its control changed from ${railOfButton.base.toFixed(4)} ` +
        `to ${railOfButton.scaled.toFixed(4)} — ${detail}`
    ).toBeLessThanOrEqual(0.02);

    // And explicitly not 1.69 anywhere: that is the number a second factor would
    // produce, so every ratio this test measured must be far below it.
    const measured = [
      { label: `word/${wordAxis} invariance`, value: wordShare.scaled / wordShare.base },
      { label: 'icon/height invariance', value: iconShare.scaled / iconShare.base },
      { label: 'tile word width', value: textRatio },
      { label: 'rail button height', value: buttonRatio },
      { label: 'rail column width', value: railRatio },
      { label: 'rail column of button', value: railOfButton.scaled / railOfButton.base }
    ] as const;
    for (const { label, value } of measured) {
      expect(
        value,
        `${count} tiles: ${label} is ${value.toFixed(3)}×, which is in double-scaling territory ` +
          `(1.69 is the second factor; 1.45 is this test's hard bound) — ${detail}`
      ).toBeLessThan(1.45);
    }

    console.log(
      `once, not twice at ${count} tiles: tile word ${base.tileWordWidth.toFixed(1)} -> ` +
        `${scaled.tileWordWidth.toFixed(1)} (${textRatio.toFixed(3)}×), ` +
        `D30 word/${wordAxis} ${wordShare.base.toFixed(4)} -> ${wordShare.scaled.toFixed(4)}, ` +
        `icon/height ${iconShare.base.toFixed(4)} -> ${iconShare.scaled.toFixed(4)}, ` +
        `(cross-axis word/other ${(base.tileWordWidth / base.tile[wordAxis === 'width' ? 'height' : 'width']).toFixed(4)} -> ` +
        `${(scaled.tileWordWidth / scaled.tile[wordAxis === 'width' ? 'height' : 'width']).toFixed(4)}, ` +
        `icon/width ${(base.tileIcon.width / base.tile.width).toFixed(4)} -> ` +
        `${(scaled.tileIcon.width / scaled.tile.width).toFixed(4)}), ` +
        `rail button ${base.railButton.height.toFixed(1)} -> ` +
        `${scaled.railButton.height.toFixed(1)} (${buttonRatio.toFixed(3)}×), ` +
        `rail column ${base.rail.width.toFixed(1)} -> ` +
        `${scaled.rail.width.toFixed(1)} (${railRatio.toFixed(3)}×)`
    );
  }

  watch.assertAllLocal();
});

test('ui.scale raises the D30 px floors by exactly one factor, not two', async ({ page, request }) => {
  // Nine tiles at 1024×600 puts the tile's name on its `max(16px, …)` floor:
  // the container-query term (5.5cqi / 7cqb of a ~160×100 tile) is under 16px,
  // so the floor is what decides the size. That makes the floor measurable.
  await openWithScale(page, request, 9, SMALLEST, 100);
  const base = await measureRendered(page);
  const baseEm = await nameEmSize(page);

  await openWithScale(page, request, 9, SMALLEST, 130);
  const scaled = await measureRendered(page);
  const scaledEm = await nameEmSize(page);

  const detail =
    `1024x600, 9 tiles, first tile's name: 100% ` +
    `${base.tileNameWidth.toFixed(2)}px wide at ${baseEm.toFixed(2)}px em, 130% ` +
    `${scaled.tileNameWidth.toFixed(2)}px wide at ${scaledEm.toFixed(2)}px em`;

  // The floor, in rendered px. `16px` is the tile's `--tile-name` floor: the
  // browser reports the computed font size *without* the root zoom, so the
  // product with that zoom is the rendered em. At 100% the floor must be exactly
  // 16 (it is the value that won, not a container fraction), and at 130% exactly
  // 16 × 1.3 = 20.8 — one factor.
  expect(baseEm, `the name is not on its 16px floor at 100%: ${baseEm.toFixed(2)}px — ${detail}`)
    .toBeGreaterThanOrEqual(16 - 0.6);
  expect(baseEm, `the name is larger than its 16px floor at 100%: ${baseEm.toFixed(2)}px — ${detail}`)
    .toBeLessThanOrEqual(16 + 0.6);
  expect(
    scaledEm,
    `the floor rendered ${scaledEm.toFixed(2)}px at 130%, not 16 × 1.3 = 20.8px — ${detail}`
  ).toBeGreaterThanOrEqual(20.8 - 0.9);
  expect(
    scaledEm,
    `the floor rendered ${scaledEm.toFixed(2)}px at 130%, not 16 × 1.3 = 20.8px — ${detail}`
  ).toBeLessThanOrEqual(20.8 + 0.9);
  // A second factor renders 16 × 1.69 = 27.04px.
  expect(scaledEm, `the floor took a second factor (27px is 16 × 1.69) — ${detail}`).toBeLessThan(
    16 * 1.69 - 1
  );

  // The paint, not only the computed style: the `Range` width is linear in the
  // font size, so the rendered text really moved by the one factor. Glyph shapes
  // make the absolute width meaningless, its ratio is not.
  const ratio = scaled.tileNameWidth / base.tileNameWidth;
  expect(ratio, `the name's painted width moved by ${ratio.toFixed(3)}×, not 1.3× — ${detail}`)
    .toBeGreaterThanOrEqual(1.25);
  expect(ratio, `the name's painted width moved by ${ratio.toFixed(3)}×, not 1.3× — ${detail}`)
    .toBeLessThanOrEqual(1.36);
  expect(
    ratio,
    `the name's painted width moved by ${ratio.toFixed(3)}×, which is a second factor — ${detail}`
  ).toBeLessThan(1.45);

  console.log(
    `D30 floors: name ${base.tileNameWidth.toFixed(2)} -> ${scaled.tileNameWidth.toFixed(2)} ` +
      `(${ratio.toFixed(3)}×), em ${baseEm.toFixed(2)} -> ${scaledEm.toFixed(2)}`
  );

  watch.assertAllLocal();
});

/** What the first frame after a reload saw, recorded by an init script. */
type ScaleProbe = readonly [string, string | null, string, boolean];

test('a stored scale is applied before the first paint', async ({ page, request }) => {
  // 1. The app caches the step it adopted, which is what the inline script can
  // read before any request has answered.
  await applyScale(request, 130);
  await page.goto('/');
  await expect(page.locator(TILES).first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('doorbell.scale')))
    .toBe('130');

  // 2. The inline script alone. With every module script dead, the only code
  // that ran is `index.html`'s parser-blocking inline head script — it finishes
  // before `<body>` exists, so the attribute is present in the first style
  // resolution the document ever has. No app code is loaded at all, so nothing
  // could have been "applied quickly after" a first frame: a paint cannot
  // precede a parser-blocking script in `<head>`.
  await page.route('**/*.js', (route) => route.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '130');
  const inlineZoom = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).zoom)
  );
  expect(
    inlineZoom,
    `the inline script set the attribute but the root zoom is ${inlineZoom}, not 1.3`
  ).toBeCloseTo(1.3, 5);
  await page.unroute('**/*.js');

  // 3. The first frame itself: a rAF registered from an init script runs before
  // the app's first paint, and records what the document looked like then.
  await page.addInitScript(() => {
    const holder = window as unknown as { __scaleProbe?: ScaleProbe | null };
    holder.__scaleProbe = null;
    requestAnimationFrame(() => {
      holder.__scaleProbe = [
        document.readyState,
        document.documentElement.dataset.uiScale ?? null,
        getComputedStyle(document.documentElement).zoom,
        document.querySelector('#app') !== null
      ];
    });
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __scaleProbe?: unknown }).__scaleProbe))
    .not.toBeNull();

  const probe = await page.evaluate(() => {
    const holder = window as unknown as { __scaleProbe?: ScaleProbe | null };
    const recorded = holder.__scaleProbe ?? null;
    if (recorded === null) {
      throw new Error('the first-frame probe never ran');
    }
    return recorded;
  });
  const [readyState, probeAttr, probeZoom, appPresent] = probe;
  const probeDetail =
    `first frame: readyState ${readyState}, data-ui-scale ${probeAttr}, zoom ${probeZoom}, ` +
    `#app ${appPresent ? 'present' : 'absent'}`;
  expect(probeAttr, `the first frame was not scaled yet — ${probeDetail}`).toBe('130');
  expect(parseFloat(probeZoom), `the first frame had no root zoom — ${probeDetail}`).toBeCloseTo(
    1.3,
    5
  );

  // 4. Control: with nothing stored and the installation back at 100%, the
  // attribute is absent and the root zoom is exactly 1 — the default path
  // renders exactly as it did before this setting existed.
  await applyScale(request, 100);
  await page.evaluate(() => localStorage.removeItem('doorbell.scale'));
  await page.reload();
  await expect(page.locator(TILES).first()).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-ui-scale');
  const idleZoom = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).zoom)
  );
  expect(idleZoom, `the default step must leave the root unzoomed, got ${idleZoom}`).toBeCloseTo(
    1,
    5
  );
  expect(
    await page.evaluate(() => localStorage.getItem('doorbell.scale')),
    'the default step must not cache a value that the inline script would re-apply'
  ).not.toBe('130');

  console.log(`pre-paint scale: ${probeDetail}`);

  watch.assertAllLocal();
});

test('ui.scale scales sheets and the settings screens', async ({ page, request }) => {
  test.setTimeout(120_000);

  const scaleTrigger = page.getByRole('button', { name: /^Interface scale/ });
  const sheet = page.locator('dialog.sheet[open]');

  for (const step of SCALE_STEPS) {
    await applyScale(request, step);
    await page.goto('/settings/appearance');
    await expectScaleApplied(page, step);

    await expect(scaleTrigger, `ui.scale ${step}: the Appearance panel is not loaded`).toBeVisible();
    await scaleTrigger.click();
    await expect(sheet, `ui.scale ${step}: the picker sheet did not open`).toBeVisible();

    const measured = await measureSheet(page);
    const detail = `ui.scale ${step} on /settings/appearance: ${JSON.stringify(measured)}`;

    // A sheet is the one surface that can leave the viewport while the page
    // itself does not: it is positioned against the viewport in the zoomed
    // coordinate space, and `--viewport-height` is what divides that back.
    expect(measured.rect.left, `the sheet starts left of the viewport — ${detail}`).toBeGreaterThanOrEqual(
      -1
    );
    expect(
      measured.rect.right,
      `the sheet runs past the viewport's right edge — ${detail}`
    ).toBeLessThanOrEqual(measured.innerWidth + 1);
    expect(measured.rect.top, `the sheet starts above the viewport — ${detail}`).toBeGreaterThanOrEqual(
      -1
    );
    expect(
      measured.rect.bottom,
      `the sheet runs past the viewport's bottom edge — ${detail}`
    ).toBeLessThanOrEqual(measured.innerHeight + 1);

    expect(measured.rowOverflow, `a picker row clips its own text — ${detail}`).toEqual([]);
    for (const height of measured.rowHeights) {
      expect(
        height,
        `a picker row is ${height.toFixed(2)}px tall, below --tap (48 rendered) — ${detail}`
      ).toBeGreaterThanOrEqual(48);
    }

    // The sheet's text. `--text-body` is a layout size, so it moves by the one
    // factor with the rest of the interface: at 100% and above the D26 16px line
    // is what it paints, and at 85% the same text paints 16 × 0.85 = 13.6px by
    // design (a flat 16px here would mean the text *stopped* following the zoom).
    const factor = step / 100;
    const textFloor = step >= 100 ? 16 : 16 * factor;
    for (const size of measured.textSizes) {
      expect(
        size,
        `${size.toFixed(2)}px rendered text is below the ${textFloor.toFixed(2)}px floor for ` +
          `this step — ${detail}`
      ).toBeGreaterThanOrEqual(textFloor - 0.6);
    }

    // Zoom must not add a horizontal scrollbar: `zoom` on <html> multiplies a
    // shell that was laid out for `100dvh / var(--ui-scale)`.
    expect(
      measured.scrollWidth,
      `zooming produced horizontal document overflow (scrollWidth ${measured.scrollWidth} vs ` +
        `clientWidth ${measured.clientWidth}) — ${detail}`
    ).toBeLessThanOrEqual(measured.clientWidth + 1);

    console.log(
      `sheet at ${step}%: ${measured.rect.width.toFixed(0)}x${measured.rect.height.toFixed(0)} ` +
        `inside ${measured.innerWidth}x${measured.innerHeight}, rows ` +
        `${measured.rowHeights.map((height) => height.toFixed(1)).join('/')}, ` +
        `text ${measured.textSizes.map((size) => size.toFixed(2)).join('/')}`
    );

    // Escape, not the close button: the sheet's exit path is the dialog's own.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  }

  // 130%, keyboard only: Tab to the scale picker and open it with Enter, so the
  // ring painted below is a `:focus-visible` ring on a keyboard-focused control,
  // never the ring of a pointer click. The reference panel is used here because
  // its sheet is the *bottom* sheet (>1024px wide), the branch whose width and
  // `--viewport-height` are the ones `ui.scale` has to divide back.
  await applyScale(request, 130);
  await page.setViewportSize(PANEL);
  await page.goto('/settings/appearance');
  await expectScaleApplied(page, 130);
  await expect(scaleTrigger).toBeVisible();

  const reachedByTab = await tabToFocused(page, scaleTrigger, 80);
  // A one-line escape hatch: if the tab order ever stops reaching the picker
  // (a section inserted before it, a focus trap), parking focus directly still
  // proves the ring, and the fallback is reported rather than hidden.
  if (!reachedByTab) {
    await scaleTrigger.focus();
  }

  await page.keyboard.press('Enter');
  await expect(sheet, 'the scale picker did not open from the keyboard').toBeVisible();

  // The bottom-sheet branch: at 130% its 600px width renders 780px and its
  // `calc(var(--viewport-height) * 0.8)` height renders 0.8 × 720 — both inside
  // the panel only because the viewport is divided back once in `tokens.css`.
  const bottomSheet = await measureSheet(page);
  const bottomDetail =
    `ui.scale 130 on ${PANEL.width}x${PANEL.height}: ${JSON.stringify(bottomSheet)}`;
  expect(bottomSheet.rect.left, `the bottom sheet starts left of the viewport — ${bottomDetail}`)
    .toBeGreaterThanOrEqual(-1);
  expect(
    bottomSheet.rect.right,
    `the bottom sheet runs past the viewport — ${bottomDetail}`
  ).toBeLessThanOrEqual(bottomSheet.innerWidth + 1);
  expect(bottomSheet.rect.top, `the bottom sheet starts above the viewport — ${bottomDetail}`)
    .toBeGreaterThanOrEqual(-1);
  expect(
    bottomSheet.rect.bottom,
    `the bottom sheet runs past the viewport bottom — ${bottomDetail}`
  ).toBeLessThanOrEqual(bottomSheet.innerHeight + 1);
  expect(
    bottomSheet.scrollWidth,
    `the bottom sheet added horizontal document overflow — ${bottomDetail}`
  ).toBeLessThanOrEqual(bottomSheet.clientWidth + 1);
  for (const height of bottomSheet.rowHeights) {
    expect(height, `a bottom-sheet row is shorter than 48 rendered — ${bottomDetail}`)
      .toBeGreaterThanOrEqual(48);
  }

  // Opening moves focus to the selected row; the row paints the ring for its
  // sr-only radio through `.row:has(:focus-visible)`. Polled, because the focus
  // move happens a tick after the dialog opens.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (active === null) {
            return 0;
          }
          const row = active.closest('label.row');
          return row === null ? 0 : parseFloat(getComputedStyle(row).outlineWidth);
        }),
      { message: 'the keyboard-focused picker row paints no focus ring' }
    )
    .toBeGreaterThan(0);

  const ring = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) {
      throw new Error('nothing is focused after the sheet opened');
    }
    const row = active.closest('label.row');
    if (row === null) {
      throw new Error('the sheet put focus outside its option rows');
    }
    const style = getComputedStyle(row);
    return {
      focused: active.tagName.toLowerCase(),
      focusVisible: active.matches(':focus-visible'),
      outlineWidth: parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow
    };
  });
  expect(ring.focusVisible, `the focused control is not :focus-visible ${JSON.stringify(ring)}`).toBe(
    true
  );
  expect(
    ring.outlineWidth > 0 || /inset|px/.test(ring.boxShadow),
    `the keyboard-focused row paints no ring: ${JSON.stringify(ring)}`
  ).toBe(true);

  console.log(
    `keyboard ring at 130%: ${JSON.stringify(ring)}, reached by Tab: ${reachedByTab}; ` +
      `bottom sheet ${bottomSheet.rect.width.toFixed(0)}x${bottomSheet.rect.height.toFixed(0)} ` +
      `in ${bottomSheet.innerWidth}x${bottomSheet.innerHeight}`
  );

  watch.assertAllLocal();
});

/**
 * The control rail: four 80px controls in a fixed 112px column (D28), with no
 * visible text left to clip and the volume stage in the accessibility tree
 * instead of on the wall display.
 *
 * cd-bdjz widened it from 56/72 to 80/96 because the owner read the column as
 * wasted horizontal space, then re-spent the column's own gutters on `--gap`
 * (16px either side of the control, 80/112) so the rail's seams match the
 * grid's. The vertical gap between the separate targets is deliberately
 * unchanged at 16px -- four separate targets, not one segmented strip.
 *
 * cd-qpg6 shipped twice. The first pass sized the caption pill to its word and
 * let the column grow with it -- an elaborate proof that a word can be made to
 * fit at 5px more. The owner overruled the whole shape of that fix ("are the
 * volume controls still there? They need to be. But the text 'software' or
 * whatever should be in the config somewhere if anywhere"): the label belongs in
 * Settings -> Audio, so the rail has no caption and nothing to clip. These
 * assertions therefore pin the *absence* -- the overflow cannot come back without
 * a visible text node in the rail failing clause 3 -- as well as the box the
 * removed pill used to widen.
 */
test('the control rail is four 80px controls in a 112px column with no text to clip', async ({
  page,
  request
}) => {
  // Ten page loads (eight measured panels, two behaviour taps) plus the real
  // backend reads behind each one: the default 60s per test is not enough
  // headroom for the tier's own 300s global budget.
  test.setTimeout(150_000);

  /** `--rail-column`: `--rail-control` (80) plus one `--gap` (16) either side. */
  const RAIL_COLUMN_WIDTH = 112;
  /**
   * `--rail-control`: the square each control is painted at. It was
   * `--tap-primary` (56) before cd-bdjz.
   */
  const CONTROL_SIZE = 80;
  /**
   * Sub-pixel tolerance. `getBoundingClientRect()` returns fractions of a layout
   * px, and the rail is a `calc()` of two tokens, so the honest number is "112 to
   * within rounding" rather than exactly 112.0.
   */
  const TOLERANCE = 0.5;

  const rail = page.locator('[data-testid="control-rail"]');
  const stage = page.locator('[data-testid="rail-volume-stage"]');
  const removedPill = page.locator('[data-testid="rail-volume-target"]');
  const controls = rail.locator('.control');

  // `audio.muted` is not one of the bench's canonical settings, so the mute
  // button's accessible name depends on whatever the previous spec left behind.
  // Seed it false: this test asserts the name, not the toggle order.
  const unmuted = await request.patch('/api/settings', { data: { 'audio.muted': false } });
  expect(unmuted.ok(), await unmuted.text()).toBe(true);

  for (const target of ['software', 'hardware'] as const) {
    for (const { width, height } of RAIL_VIEWPORTS) {
      await applyRailTarget(request, target);
      await page.setViewportSize({ width, height });
      await page.goto('/');
      // Auto-retrying on the real snapshot, never a bare timeout: a measurement
      // must never describe a page that has not finished loading.
      await expect(page.locator(LIVE_TILES)).toHaveCount(SEED.length);

      const measured = await page.evaluate((): RailGeometry => {
        function boxOf(element: Element): BoxRect {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          };
        }

        const root = document.querySelector('[data-testid="control-rail"]');
        if (root === null) {
          throw new Error('the dashboard has no control rail to measure');
        }

        const stageNode = root.querySelector('[data-testid="rail-volume-stage"]');

        return {
          rail: boxOf(root),
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          clientWidth: root.clientWidth,
          clientHeight: root.clientHeight,
          stageText: (stageNode?.textContent ?? '').replace(/\s+/g, ' ').trim()
        };
      });

      /*
       * Text that is *visible* on the wall display: a direct child text node with
       * something in it, unless the node sits inside the `.sr-only` clip. `sr-only`
       * is a 1px clip, not `display: none`, so the sentence still contributes to
       * `textContent` and is still announced -- what it never does is paint. A
       * caption pill re-added to the rail shows up here as a non-empty entry,
       * which is the point of collecting the list rather than asserting
       * `textContent` is empty.
       */
      const visibleTexts = await page.evaluate(visibleTextsUnder, '[data-testid="control-rail"]');

      const detail =
        `${target} rail at ${width}x${height}: rail ${JSON.stringify(measured.rail)}, ` +
        `scroll ${measured.scrollWidth}x${measured.scrollHeight}, ` +
        `client ${measured.clientWidth}x${measured.clientHeight}, ` +
        `visible text ${JSON.stringify(visibleTexts)}, ` +
        `stage ${JSON.stringify(measured.stageText)}`;

      // Logged before the assertions, so the numbers are in the report even when
      // one of them fires.
      console.log(
        `rail ${target} at ${width}x${height}: column ` +
          `${measured.rail.width.toFixed(2)}x${measured.rail.height.toFixed(2)}, ` +
          `scroll ${measured.scrollWidth} -> client ${measured.clientWidth}, ` +
          `visible text nodes ${visibleTexts.length}`
      );

      // The column the removed pill used to widen: a fixed 112px, not a
      // viewport share and not a shrink-to-fit around a word.
      expect(measured.rail.width, detail).toBeGreaterThanOrEqual(RAIL_COLUMN_WIDTH - TOLERANCE);
      expect(measured.rail.width, detail).toBeLessThanOrEqual(RAIL_COLUMN_WIDTH + TOLERANCE);

      // Nothing in the rail overflows it -- the fill contract's own rule, applied
      // to the column that sits beside the tiles.
      expect(measured.scrollWidth, detail).toBeLessThanOrEqual(measured.clientWidth);
      expect(measured.scrollHeight, detail).toBeLessThanOrEqual(measured.clientHeight);

      // Clause 3: the rail paints no text at all. This is the assertion that
      // fails if a caption pill is ever put back on the wall display, and it is
      // what fails on the pre-change bundle, where the pill reads `Software`.
      expect(visibleTexts, detail).toEqual([]);

      // The four controls, in order, unchanged. Their order is the rail's
      // contract: ⬆, ⬇, mute, then the gear that navigates away.
      await expect(controls).toHaveCount(4);
      const testIds = await controls.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-testid'))
      );
      expect(testIds, detail).toEqual([
        'rail-volume-up',
        'rail-volume-down',
        'rail-mute',
        'rail-settings'
      ]);

      const names = [
        `Turn ${target} volume up`,
        `Turn ${target} volume down`,
        'Mute',
        'Settings'
      ] as const;
      const roles = ['button', 'button', 'button', 'link'] as const;

      for (let index = 0; index < names.length; index += 1) {
        const control = controls.nth(index);
        const box = await renderedBoxOf(control);
        const boxDetail = `${detail}; control ${index} ${JSON.stringify(box)}`;

        // 80x80 is `--rail-control`, square, at every panel size in
        // `RAIL_VIEWPORTS`.
        expect(box.width, boxDetail).toBeGreaterThanOrEqual(CONTROL_SIZE - TOLERANCE);
        expect(box.width, boxDetail).toBeLessThanOrEqual(CONTROL_SIZE + TOLERANCE);
        expect(box.height, boxDetail).toBeGreaterThanOrEqual(CONTROL_SIZE - TOLERANCE);
        expect(box.height, boxDetail).toBeLessThanOrEqual(CONTROL_SIZE + TOLERANCE);

        // And inside the column that holds it, so a control can never paint over
        // the tiles beside the rail.
        expect(box.left, detail).toBeGreaterThanOrEqual(measured.rail.left - TOLERANCE);
        expect(box.right, detail).toBeLessThanOrEqual(measured.rail.right + TOLERANCE);
        expect(box.top, detail).toBeGreaterThanOrEqual(measured.rail.top - TOLERANCE);
        expect(box.bottom, detail).toBeLessThanOrEqual(measured.rail.bottom + TOLERANCE);

        // The name is the rail's only per-stage cue now, and it is computed by
        // the ARIA algorithm rather than read off an attribute, so a control that
        // lost its `aria-label` fails here.
        await expect(control).toHaveAccessibleName(names[index]);
        await expect(
          page.getByRole(roles[index], { name: names[index], exact: true })
        ).toHaveCount(1);
      }

      // The stage survives as the group's description: `aria-describedby` plus a
      // clipped sentence, which is announced but never painted.
      // `toHaveAccessibleDescription` runs the ARIA algorithm over the referenced
      // node, so this asserts the sentence is in the accessibility tree rather
      // than merely in the DOM (a `display: none` target would resolve to
      // nothing).
      const sentence = `The volume buttons change ${target} volume.`;
      await expect(rail).toHaveAccessibleDescription(sentence);
      expect(measured.stageText, detail).toBe(sentence);

      await expect(removedPill).toHaveCount(0);
      await expect(stage).toHaveCount(1);
      await expect(stage).toHaveText(sentence);
    }
  }

  // And the four controls still ACT. Behaviour is viewport-independent, so this
  // runs once per stage rather than six times: one tap, one PATCH, one key.
  //
  // Each stage is seeded from the reset baseline (both volumes are 100) to a
  // value with room above it, so the echoed number is a literal instead of a
  // read-back that a broken tap could satisfy.
  const taps = [
    { target: 'software', key: 'audio.volume', seeded: 70, expected: 75 },
    { target: 'hardware', key: 'audio.hardware_volume', seeded: 40, expected: 45 }
  ] as const;

  for (const { target, key, seeded, expected } of taps) {
    const seed = await request.patch('/api/settings', { data: { [key]: seeded } });
    expect(seed.ok(), await seed.text()).toBe(true);

    await applyRailTarget(request, target);
    await page.setViewportSize({ ...PANEL });
    await page.goto('/');
    await expect(page.locator(LIVE_TILES)).toHaveCount(SEED.length);

    const patched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/settings' &&
        response.request().method() === 'PATCH'
    );
    await page
      .getByRole('button', { name: `Turn ${target} volume up`, exact: true })
      .click();
    const response = await patched;
    expect(response.ok(), await response.text()).toBe(true);

    // The rail sends a *diff*, so one key per tap is the contract: a stage switch
    // that leaked the other volume, or a mute flag riding along, would still save
    // something -- just the wrong something.
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    const sentKeys = Object.keys(sent);
    expect(sentKeys, `${target} tap PATCHed ${JSON.stringify(sent)}`).toHaveLength(1);
    expect(sentKeys[0]).toBe(key);

    // And the echo is the value this tap asked for: `stepVolume` is +5, clamped to
    // the 0..100 range.
    const body = (await response.json()) as { settings?: Record<string, unknown> };
    expect(body.settings?.[key], `${target} tap on ${key} at ${seeded}`).toBe(expected);
  }

  watch.assertAllLocal();
});

/** The rail's painted frames, collected in one page evaluation. */
interface ControlFrames {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly controls: readonly BoxRect[];
}

/** One control's icon, in both painted and viewBox terms. */
interface GlyphMetrics {
  /** The control's own painted width: `--rail-control`, or the clamp's answer. */
  readonly controlWidth: number;
  /** The `svg` box inside it — a percentage of the control, not a px `size`. */
  readonly svgWidth: number;
  /** The `path`'s own box, in viewBox units: the MDI volume glyph is 19 of 24. */
  readonly bboxWidth: number;
  /** The `viewBox` width, in the same units. */
  readonly viewBoxWidth: number;
}

/**
 * The wider rail (cd-bdjz): 80px controls in a 112px column, with the tiles still
 * covering the panel the D30 contract asks for, and every horizontal seam on the
 * dashboard measuring the same 16px `--gap`.
 *
 * Two questions at once, on purpose. Widening the column spends tile area, and
 * the acceptance criterion is that the grid keeps filling the panel — so the
 * fill contract is re-run here, at the ticket's four panels, instead of trusted
 * from the earlier tests. And the control is one square in one column: the
 * failure this test has to rule out is a rail that grows by merging four targets
 * into a single strip, which would satisfy a width assertion and lose four tap
 * targets, so the gaps and the parent structure are asserted too.
 *
 * The 16px gutters are asserted by measurement in the same test, on all five
 * seams the panel shows: the edge to the first tile, tile to tile inside the
 * first row, the grid's right edge to the control's left edge, the control's
 * right edge to the screen edge, and the title's left edge against the first
 * tile's. A panel that centred the grid, or one that paid for the wider rail out
 * of one side, moves at least one of them.
 */
test('every horizontal gutter on the dashboard is 16px, and the wider rail keeps the tiles filling the panel', async ({
  page,
  request
}) => {
  // Four page loads (one per panel) plus the real backend reads behind each one,
  // with the same headroom argument as the rail test above.
  test.setTimeout(120_000);

  /**
   * The panels the ticket names: the reference panel the owner measured the rail
   * at, the wall panel, the largest landscape panel, and portrait (D30).
   */
  const PANELS = [
    { width: 1280, height: 720 },
    { width: 1024, height: 600 },
    { width: 1920, height: 1080 },
    { width: 720, height: 1280 } // portrait: the rail is not a landscape-only rule
  ] as const;

  /** `--rail-column`: `--rail-control` (80) plus one `--gap` (16) either side. */
  const RAIL_COLUMN_WIDTH = 112;
  /** `--rail-control`: the square each control is painted at. It was 56 before. */
  const CONTROL_SIZE = 80;
  /**
   * Sub-pixel tolerance, as in the rail test above: `getBoundingClientRect()`
   * returns fractions of a layout px and the column is a `calc()` of two tokens.
   */
  const TOLERANCE = 0.5;
  /**
   * The measured gap between two adjacent controls at 100% — `--gap`. The floor
   * asserted below is 12, not 16, because a future scale step may resolve the
   * rail's own layout a hair under; what the assertion forbids is a rail whose
   * targets touch.
   */
  const MIN_GAP = 12;
  /** The owner's gutter: `--gap`, the one inset the panel spends on every seam. */
  const GUTTER = 16;
  /**
   * Tolerance for a `--gap` measured on screen. `getBoundingClientRect()` returns
   * fractions of a layout px, and the grid's last track absorbs the division
   * remainder (a 1280px panel's columns come back 373.328125 / 373.34375), so a
   * gutter can land a fraction off 16. ±1px is the honest bound: a real 15px or
   * 17px gutter still fails, while a wider bound would stop proving 16 at all.
   */
  const GUTTER_TOLERANCE = 1;

  const rail = page.locator('[data-testid="control-rail"]');
  const stage = page.locator('[data-testid="rail-volume-stage"]');
  const controls = rail.locator('.control');
  const header = page.locator('.header');

  const names = [
    'Turn software volume up',
    'Turn software volume down',
    'Mute',
    'Settings'
  ] as const;
  const sentence = 'The volume buttons change software volume.';

  // `audio.muted` is not one of the bench's canonical settings, so the mute
  // control's accessible name depends on whatever the previous spec left behind.
  // Seed it false: this test asserts the name, not the toggle order.
  const unmuted = await request.patch('/api/settings', { data: { 'audio.muted': false } });
  expect(unmuted.ok(), await unmuted.text()).toBe(true);

  for (const viewport of PANELS) {
    await openWithTiles(page, request, SEED.length, viewport);

    const geometry = await measureFill(page);
    const detail = detailOf(`wider rail at ${viewport.width}x${viewport.height}`, geometry);
    expect(geometry.rail, `the dashboard has no control rail to measure — ${detail}`).not.toBeNull();

    const railBox = await renderedBoxOf(rail);
    const headerBox = await renderedBoxOf(header);

    const frame = await page.evaluate((): ControlFrames => {
      function boxOf(element: Element): BoxRect {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      }

      const root = document.querySelector('[data-testid="control-rail"]');
      if (root === null) {
        throw new Error('the dashboard has no control rail to measure');
      }
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        controls: Array.from(root.querySelectorAll('.control')).map(boxOf)
      };
    });

    const glyph = await controls.first().evaluate((control): GlyphMetrics => {
      const svg = control.querySelector('svg');
      const path = svg === null ? null : svg.querySelector('path');
      if (svg === null || path === null) {
        throw new Error('the first rail control has no svg path to measure');
      }
      return {
        controlWidth: control.getBoundingClientRect().width,
        svgWidth: svg.getBoundingClientRect().width,
        bboxWidth: (path as SVGGraphicsElement).getBBox().width,
        viewBoxWidth: (svg as SVGSVGElement).viewBox.baseVal.width
      };
    });

    // Guard first: the loops below index into this list.
    expect(frame.controls, detail).toHaveLength(4);

    const gaps = frame.controls
      .slice(1)
      .map((control, index) => control.top - frame.controls[index].bottom);
    const glyphShare =
      (glyph.bboxWidth / glyph.viewBoxWidth) * (glyph.svgWidth / glyph.controlWidth);
    const border = borderCoverageOf(geometry);

    // The panel's horizontal seams, measured rather than read off the stylesheet.
    // The viewport starts at 0, so the first tile's `left` *is* the edge gutter.
    const title = await renderedBoxOf(page.locator('.product'));
    const leftmost = [...geometry.tiles].sort((a, b) => a.left - b.left)[0];
    const lowestTop = Math.min(...geometry.tiles.map((tile) => tile.top));
    const firstRow = [...geometry.tiles]
      .filter((tile) => tile.top === lowestTop)
      .sort((a, b) => a.left - b.left);
    const edgeToTile = leftmost.left;
    const betweenTiles = firstRow
      .slice(1)
      .map((tile, index) => tile.left - firstRow[index].right);
    const rightmostTile = Math.max(...geometry.tiles.map((tile) => tile.right));
    const gridToControl = frame.controls[0].left - rightmostTile;
    const controlToEdge = frame.innerWidth - frame.controls[0].right;
    const titleToTile = Math.abs(title.left - leftmost.left);
    const gutterDetail =
      `${detail}; edge→tile ${edgeToTile.toFixed(2)}, ` +
      `tile→tile ${betweenTiles.map((gap) => gap.toFixed(2)).join('/')}, ` +
      `grid→control ${gridToControl.toFixed(2)}, control→edge ${controlToEdge.toFixed(2)}, ` +
      `title→tile ${titleToTile.toFixed(2)}`;

    // Logged before the assertions, so the numbers are in the report even when
    // one of them fires.
    console.log(
      `wider rail at ${viewport.width}x${viewport.height}: column ` +
        `${railBox.width.toFixed(2)}x${railBox.height.toFixed(2)}, control ` +
        `${frame.controls[0].width.toFixed(2)}, gaps ` +
        `${gaps.map((gap) => gap.toFixed(1)).join('/')}, tiles ` +
        `${(border.width * 100).toFixed(1)}%/${(border.height * 100).toFixed(1)}% of the panel, ` +
        `glyph ${(glyphShare * 100).toFixed(1)}% of the control, ` +
        `gutters edge→tile ${edgeToTile.toFixed(2)}, ` +
        `tile→tile ${betweenTiles.map((gap) => gap.toFixed(2)).join('/')}, ` +
        `grid→control ${gridToControl.toFixed(2)}, ` +
        `control→edge ${controlToEdge.toFixed(2)}, title→tile ${titleToTile.toFixed(2)}`
    );

    // The D30 contract, unchanged and re-run: the wider column may not be paid
    // for out of the grid. Both boxes, because they answer different questions —
    // the border box is the panel the owner sees, the content box is the area
    // the grid was handed (AC 5 literally).
    expectTilesCoverContentBox(geometry, detail);
    expectTilesFillContent(geometry, detail);
    expectPanelCoverage(geometry, detail);

    // The column: 112px, not a viewport share, and wholly on screen.
    expect(railBox.width, detail).toBeGreaterThanOrEqual(RAIL_COLUMN_WIDTH - TOLERANCE);
    expect(railBox.width, detail).toBeLessThanOrEqual(RAIL_COLUMN_WIDTH + TOLERANCE);
    expect(railBox.left, detail).toBeGreaterThanOrEqual(0);
    expect(railBox.right, detail).toBeLessThanOrEqual(frame.innerWidth);
    expect(railBox.bottom, detail).toBeLessThanOrEqual(frame.innerHeight);

    // The five horizontal gutters, each one `--gap` (16px). The first row is the
    // row the intra-row loop reads, and one tile in it would make that loop
    // vacuous, so the row is guarded before the gaps are asserted.
    expect(firstRow.length, gutterDetail).toBeGreaterThan(1);
    expect(
      Math.abs(edgeToTile - GUTTER),
      `the edge → first tile gutter is not ${GUTTER}px — ${gutterDetail}`
    ).toBeLessThanOrEqual(GUTTER_TOLERANCE);
    for (const [index, gap] of betweenTiles.entries()) {
      expect(
        Math.abs(gap - GUTTER),
        `the tile ${index} → tile ${index + 1} gutter is not ${GUTTER}px — ${gutterDetail}`
      ).toBeLessThanOrEqual(GUTTER_TOLERANCE);
    }
    expect(
      Math.abs(gridToControl - GUTTER),
      `the grid → rail control gutter is not ${GUTTER}px — ${gutterDetail}`
    ).toBeLessThanOrEqual(GUTTER_TOLERANCE);
    expect(
      Math.abs(controlToEdge - GUTTER),
      `the rail control → screen edge gutter is not ${GUTTER}px — ${gutterDetail}`
    ).toBeLessThanOrEqual(GUTTER_TOLERANCE);
    // The title sits in the header, not the grid, so this is a same-inset check
    // rather than a gap: `.product`'s left edge lines up with the first tile's.
    expect(
      titleToTile,
      `the title does not line up with the first tile — ${gutterDetail}`
    ).toBeLessThanOrEqual(GUTTER_TOLERANCE);

    for (const [index, control] of frame.controls.entries()) {
      const boxDetail = `${detail}; control ${index} ${JSON.stringify(control)}`;

      // Square, and at least the ticket's new minimum: 80px is bigger than the
      // 56px `--tap-primary` square the rail used to be, which is the point.
      expect(Math.abs(control.width - control.height), boxDetail).toBeLessThanOrEqual(TOLERANCE);
      expect(control.width, boxDetail).toBeGreaterThanOrEqual(CONTROL_SIZE - TOLERANCE);

      // Inside the column that holds it, and inside the panel.
      expect(control.left, boxDetail).toBeGreaterThanOrEqual(railBox.left - TOLERANCE);
      expect(control.right, boxDetail).toBeLessThanOrEqual(railBox.right + TOLERANCE);
      expect(control.top, boxDetail).toBeGreaterThanOrEqual(railBox.top - TOLERANCE);
      expect(control.bottom, boxDetail).toBeLessThanOrEqual(railBox.bottom + TOLERANCE);
      expect(control.left, boxDetail).toBeGreaterThanOrEqual(0);
      expect(control.right, boxDetail).toBeLessThanOrEqual(frame.innerWidth);
      expect(control.bottom, boxDetail).toBeLessThanOrEqual(frame.innerHeight);

      // Below the header's pills: the rail starts where the body does, so a
      // control that reached up would paint over the health badges.
      expect(control.top, boxDetail).toBeGreaterThanOrEqual(headerBox.bottom - TOLERANCE);
    }

    // No control reaches into the grid. At every landscape panel this is the
    // strict form (the rail is to the right of the last tile); a portrait panel
    // is allowed to put the rail anywhere, so the fallback is the explicit
    // intersection test rather than a looser bound.
    for (const tile of geometry.tiles) {
      for (const control of frame.controls) {
        // The rectangles intersect on both axes: a control painting over a tile.
        const overlaps =
          control.right > tile.left + TOLERANCE &&
          control.left < tile.right - TOLERANCE &&
          control.bottom > tile.top + TOLERANCE &&
          control.top < tile.bottom - TOLERANCE;
        expect(
          overlaps,
          `a control paints over a tile — ${detail}; control ${JSON.stringify(control)}, ` +
            `tile ${JSON.stringify(tile)}`
        ).toBe(false);
      }
    }

    // The owner's explicit requirement: four separate targets, nothing merged.
    // 16px measured at 100%; the 12px floor exists so a future "tidy-up" cannot
    // turn the column into one segmented strip without failing here.
    for (let index = 1; index < frame.controls.length; index += 1) {
      const above = frame.controls[index - 1];
      const below = frame.controls[index];
      expect(
        below.top - above.bottom,
        `the gap between control ${index - 1} and ${index} is not preserved — ${detail}; ` +
          `${(below.top - above.bottom).toFixed(2)}px`
      ).toBeGreaterThanOrEqual(MIN_GAP);
    }

    // And nothing merged them structurally: the rail is the controls' direct
    // parent, so there is no card, strip or grid between them.
    const parents = await controls.evaluateAll((elements) =>
      elements.map((element) => element.parentElement?.getAttribute('data-testid') ?? null)
    );
    expect(parents, detail).toEqual([
      'control-rail',
      'control-rail',
      'control-rail',
      'control-rail'
    ]);
    expect(
      await controls.evaluateAll(
        (elements) => new Set(elements.map((element) => element.parentElement)).size
      ),
      detail
    ).toBe(1);

    for (const [index, name] of names.entries()) {
      await expect(controls.nth(index), detail).toHaveAccessibleName(name);
    }

    // The stage stays a description, not a pill: the sentence is in the
    // accessibility tree and clipped, never painted.
    await expect(rail, detail).toHaveAccessibleDescription(sentence);
    await expect(stage, detail).toHaveCount(1);
    await expect(stage, detail).toHaveText(sentence);
    expect(await stage.getAttribute('class'), detail).toContain('sr-only');
    expect(await rail.getAttribute('aria-describedby'), detail).toBe(
      await stage.getAttribute('id')
    );

    // The glyph the owner actually sees, not the `svg` box around it: the MDI
    // volume path fills 19 of 24 viewBox units, so 38.6% of the control is the
    // measured answer at 100% (it was 33.9% in the old 56px control). The
    // window is wide enough for a clamp step to pick a different control size
    // and tight enough to catch a fixed `size` prop coming back.
    expect(
      glyphShare,
      `the painted glyph is ${(glyphShare * 100).toFixed(1)}% of the control, not ~38.6% — ` +
        `${detail}; ${JSON.stringify(glyph)}`
    ).toBeGreaterThanOrEqual(0.38);
    expect(
      glyphShare,
      `the painted glyph is ${(glyphShare * 100).toFixed(1)}% of the control, not ~38.6% — ` +
        `${detail}; ${JSON.stringify(glyph)}`
    ).toBeLessThanOrEqual(0.44);
  }

  watch.assertAllLocal();
});

/**
 * cd-qvt2: the header has one layout in both modes — the title (browser only)
 * and the status pills on the left `--gap`, the clock pinned to the right one.
 *
 * The defect was structural: the clock lived inside `.tools`, so with kiosk's
 * title removed, a `space-between` header put the whole cluster at the start of
 * the row and left the right-hand side of the wall empty. Here the assertions
 * are therefore two kinds at once: the **structure** (the clock is `.header`'s
 * own child, not a pill) and the **box** at five panel shapes. A clock still
 * nested in `.tools` fails the count; a clock without the auto margin fails the
 * right-gutter assertion; and a `space-between` that came back fails the gap
 * from the title to the pills.
 *
 * At the three landscape panels the pre-existing header height and first-tile
 * top are re-asserted, because the fix may not buy its right gutter from the
 * panel's vertical budget. At the two narrow widths the clock cannot share a
 * row, so the explicit non-intersection test is the wrap proof rather than a
 * lucky absence of overlap.
 */
test('cd-qvt2: the clock pins the right gutter and the pills sit by the title, in browser mode', async ({
  page,
  request
}) => {
  // Five page loads, each with the real backend reads behind it, plus the 115%
  // reload: the same headroom argument as the rail and gutter tests above.
  test.setTimeout(120_000);

  /** `--gap`: the one inset the header spends, the same 16px as the tile grid. */
  const GUTTER = 16;
  /**
   * Sub-pixel tolerance for every dimension here. `getBoundingClientRect()`
   * returns fractions of a layout px (the title comes back 162.328125 wide at
   * 1280), so ±1 is the honest bound: a 15px or 17px gutter still fails it,
   * while a looser bound would stop proving 16 at all.
   */
  const TOLERANCE = 1;
  /** The pre-existing header height at every landscape panel. */
  const LANDSCAPE_HEADER_HEIGHT = 80;
  /** `.content`'s `padding-block: var(--gap)` below that header. */
  const LANDSCAPE_FIRST_TILE_TOP = 96;

  const header = page.locator('.header');
  const tools = page.locator('.header > .tools');
  const clock = page.locator('.header > time.clock');
  const product = page.locator('.product');

  for (const viewport of HEADER_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    await openWithTiles(page, request, SEED.length, viewport);

    // The structure first: the clock left `.tools`, so it is a `.header` child
    // and not a third pill. `.tools` still exists once; a page with no clock
    // (`ui.show_clock` off) would make the box measurements below meaningless.
    await expect(tools, `the header has no .tools of its own — ${label}`).toHaveCount(1);
    await expect(clock, `the header has no own time.clock — ${label}`).toHaveCount(1);

    const headerBox = await renderedBoxOf(header);
    const toolsBox = await renderedBoxOf(tools);
    const clockBox = await renderedBoxOf(clock);
    const productBox = await renderedBoxOf(product);
    const firstTileBox = await renderedBoxOf(page.locator(TILES).first());
    const innerWidth = await page.evaluate(() => window.innerWidth);
    const scrollWidth = await page.evaluate(
      () => (document.scrollingElement ?? document.documentElement).scrollWidth
    );

    const afterTitle = toolsBox.left - productBox.right;
    const clockInset = innerWidth - clockBox.right;
    const firstTileTop = firstTileBox.top;
    // The rectangles intersect on both axes: a clock painting over a pill.
    const overlaps =
      clockBox.right > toolsBox.left + TOLERANCE &&
      clockBox.left < toolsBox.right - TOLERANCE &&
      clockBox.bottom > toolsBox.top + TOLERANCE &&
      clockBox.top < toolsBox.bottom - TOLERANCE;
    const detail =
      `header at ${label}: product ${productBox.left.toFixed(2)}→${productBox.right.toFixed(2)}, ` +
      `tools ${toolsBox.left.toFixed(2)}→${toolsBox.right.toFixed(2)}, ` +
      `clock ${clockBox.left.toFixed(2)}→${clockBox.right.toFixed(2)} ` +
      `(top ${clockBox.top.toFixed(2)}, bottom ${clockBox.bottom.toFixed(2)}), ` +
      `header ${headerBox.top.toFixed(2)}→${headerBox.bottom.toFixed(2)} ` +
      `(h ${headerBox.height.toFixed(2)}), first tile top ${firstTileTop.toFixed(2)}, ` +
      `innerWidth ${innerWidth}, scrollWidth ${scrollWidth}`;

    // Logged before the assertions, so a failure still prints the evidence.
    console.log(
      `cd-qvt2 browser ${label}: product ${productBox.left.toFixed(2)}→` +
        `${productBox.right.toFixed(2)}, tools ${toolsBox.left.toFixed(2)}→` +
        `${toolsBox.right.toFixed(2)}, clock ${clockBox.left.toFixed(2)}→` +
        `${clockBox.right.toFixed(2)}, header h ${headerBox.height.toFixed(2)}, ` +
        `first tile top ${firstTileTop.toFixed(2)}, clock inset ${clockInset.toFixed(2)}`
    );

    // The left gutter: the title on `--gap`, then the pills immediately after
    // it whenever they share a row. A `space-between` header would push the
    // pills towards the clock instead. At 720x1280 and 320x568 the pills wrap
    // to a row of their own — "immediately after the title" then means the
    // gutter, because `.tools` starts a new line at the panel's left edge.
    expect(
      Math.abs(productBox.left - GUTTER),
      `the title's left edge is not on the ${GUTTER}px gutter — ${detail}`
    ).toBeLessThanOrEqual(TOLERANCE);
    if (viewport.width > viewport.height) {
      expect(
        Math.abs(afterTitle - GUTTER),
        `the title → pills gap is not ${GUTTER}px — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    } else {
      expect(
        Math.abs(toolsBox.left - GUTTER),
        `the wrapped pills do not start on the ${GUTTER}px gutter — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    }

    // The ticket's literal criterion: `right === innerWidth - 16`.
    expect(
      Math.abs(clockInset - GUTTER),
      `the clock's right edge is not on the ${GUTTER}px gutter — ${detail}`
    ).toBeLessThanOrEqual(TOLERANCE);

    // Fully on screen, and below the header's own bottom edge: a clock pushed
    // out of the viewport by a wrapped row would fail one of these.
    expect(clockBox.left, `the clock starts off-screen — ${detail}`).toBeGreaterThanOrEqual(0);
    expect(clockBox.right, `the clock ends off-screen — ${detail}`).toBeLessThanOrEqual(innerWidth);
    expect(clockBox.top, `the clock starts above the viewport — ${detail}`).toBeGreaterThanOrEqual(0);
    expect(
      clockBox.bottom,
      `the clock hangs below the header — ${detail}`
    ).toBeLessThanOrEqual(headerBox.bottom + TOLERANCE);

    // The wrap proof: at 720x1280 and 320x568 the clock owns a row of its own,
    // so non-intersection is an explicit assertion rather than luck.
    expect(overlaps, `the clock paints over the pills — ${detail}`).toBe(false);

    // Nothing was pushed off-screen horizontally: this fails a row that grew a
    // second column instead of wrapping.
    expect(
      scrollWidth,
      `the document scrolls horizontally — ${detail}`
    ).toBeLessThanOrEqual(innerWidth + TOLERANCE);

    if (viewport.width > viewport.height) {
      // The pre-existing landscape numbers, re-asserted so the pin cannot buy
      // itself height: an 80px header puts the first tile at 96, 16px below it.
      expect(
        Math.abs(headerBox.height - LANDSCAPE_HEADER_HEIGHT),
        `the landscape header is no longer ${LANDSCAPE_HEADER_HEIGHT}px — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(firstTileTop - LANDSCAPE_FIRST_TILE_TOP),
        `the first tile no longer starts at ${LANDSCAPE_FIRST_TILE_TOP}px — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    } else {
      // `.content`'s `padding-block: var(--gap)`. The measured header heights
      // are 166 at 720x1280, 310 at 480x800 and 374 at 320x568, with first tiles
      // at 182, 326 and 390 — the clock's own wrapped row costs a header-level
      // gap. The 480x800 pair is recorded even though this list stops at 320: it
      // is the width between the two the test runs, and a future height change
      // at any of the three should be a deliberate act.
      expect(
        Math.abs(firstTileTop - (headerBox.bottom + GUTTER)),
        `the first tile is not one ${GUTTER}px gap below the header — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  }

  // The pin is a token, not a viewport fraction or a hard-coded 16: at 115% the
  // gutter itself scales, so the clock's right inset is 16 × 1.15 = 18.4px.
  // `test.afterEach` already puts `ui.scale` back to 100, which is why this
  // test does not restore it here.
  await openWithTiles(page, request, SEED.length, PANEL);
  await applyScale(request, 115);
  await page.reload();
  await expect(page.locator(TILES), 'six tiles after the 115% reload').toHaveCount(SEED.length);
  await expect(page.locator(LIVE_TILES), 'live snapshot after the 115% reload').toHaveCount(
    SEED.length
  );
  const scaledClockBox = await renderedBoxOf(clock);
  const scaledInnerWidth = await page.evaluate(() => window.innerWidth);
  const scaledInset = scaledInnerWidth - scaledClockBox.right;
  console.log(
    `cd-qvt2 browser 1280x720 @ ui.scale 115: clock right ${scaledClockBox.right.toFixed(2)}, ` +
      `inset ${scaledInset.toFixed(2)} (expected ${(GUTTER * 1.15).toFixed(2)})`
  );
  expect(
    Math.abs(scaledInset - GUTTER * 1.15),
    `the clock's right inset is ${scaledInset.toFixed(2)}px at 115%, not ${(GUTTER * 1.15).toFixed(2)}px — ` +
      `a viewport fraction or a hard-coded 16px would not scale with the token`
  ).toBeLessThanOrEqual(TOLERANCE);

  watch.assertAllLocal();
});
