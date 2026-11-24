import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The kiosk contract, measured in a real Chromium against the built artifact.
 *
 * Every test starts from the harness reset, so order never matters. The only
 * wait that is wall-clock rather than a locator is the 6 s sheet check: the
 * cursor policy is a 5 s idle timer, so a shorter wait would prove nothing.
 */

/** A tile that has a live snapshot behind it (staleness cleared). */
const LIVE_TILE = 'li.tile[data-stale="false"]';

/** Reset the harness before every test so each one starts from a known state. */
test.beforeEach(async ({ request }) => {
  const response = await request.post('/__control/reset');
  expect(response.ok()).toBe(true);
});

/** Apply a tile/chime count and (optionally) the online flag. */
async function setHarnessState(
  request: APIRequestContext,
  body: { online?: boolean; hang?: boolean; tiles?: number; chimes?: number }
): Promise<void> {
  const response = await request.post('/__control/state', { data: body });
  expect(response.ok()).toBe(true);
}

/**
 * Point the harness at the requested tile and chime counts, open the kiosk
 * dashboard, and wait until the first snapshot has painted (every tile is no
 * longer stale).
 */
async function openDashboard(page: Page, options: { tiles: number; chimes: number }): Promise<void> {
  await setHarnessState(page.request, {
    online: true,
    tiles: options.tiles,
    chimes: options.chimes
  });
  await page.goto('/?kiosk=1');
  await expect(page.locator('ul.tiles li.tile')).toHaveCount(options.tiles);
  await expect(page.locator(LIVE_TILE).first()).toBeVisible();
}

type ClipAxis = 'x' | 'y';

type ClipReason = 'ancestor' | 'self' | 'scroll';

interface ClippedItem {
  selector: string;
  text: string;
  axis: ClipAxis;
  reason: ClipReason;
  ancestor?: string;
}

interface TileSize {
  width: number;
  height: number;
}

interface OutsideItem {
  selector: string;
  text: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

interface LayoutReport {
  innerWidth: number;
  innerHeight: number;
  docScrollWidth: number;
  docScrollHeight: number;
  contentClientHeight: number;
  contentScrollHeight: number;
  contentScrollTop: number;
  tiles: TileSize[];
  clipped: ClippedItem[];
  outside: OutsideItem[];
}

/**
 * Measure the layout inside the real page.
 *
 * A text element counts as clipped only when a real box hides part of its
 * rect: an ancestor whose overflow is `hidden`/`clip` cuts it, the element's
 * own `hidden`/`clip` overflow cuts its content, or a scrollable ancestor
 * holds content behind its visible pane. A `scrollHeight > clientHeight`
 * mismatch on an `overflow: visible` element is not clipping - the font's
 * ascent/descent box can exceed the line box while every glyph stays visible.
 */
async function layoutReport(page: Page): Promise<LayoutReport> {
  return await page.evaluate((): LayoutReport => {
    const CLIP_TOLERANCE = 0.5;
    const SCROLL_TOLERANCE = 1;
    const VIEWPORT_TOLERANCE = 1;
    const TEXT_LIMIT = 40;

    function name(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const classes = Array.from(element.classList);
      return classes.length > 0 ? `${tag}.${classes.join('.')}` : tag;
    }

    function textOf(element: Element): string {
      return (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, TEXT_LIMIT);
    }

    /** Wrappers that only hold elements have no text of their own to clip. */
    function hasDirectText(element: Element): boolean {
      return Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''
      );
    }

    function hidesOverflow(value: string): boolean {
      return value === 'hidden' || value === 'clip';
    }

    function scrollsOverflow(value: string): boolean {
      return value === 'auto' || value === 'scroll';
    }

    /** The document scroller is covered by the page-level scroll assertions. */
    function isDocumentLevel(element: Element): boolean {
      return element === document.documentElement || element === document.body;
    }

    const roots: Element[] = [];
    for (const selector of ['.header', '.tiles', '.restored', '.rail']) {
      roots.push(...Array.from(document.querySelectorAll(selector)));
    }

    const candidates = new Set<Element>();
    for (const root of roots) {
      for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
        if (element.closest('.sr-only') !== null || element.closest('script, style') !== null) {
          continue;
        }
        if (element.clientWidth === 0 && element.clientHeight === 0) {
          continue;
        }
        if (!hasDirectText(element)) {
          continue;
        }
        candidates.add(element);
      }
    }

    const clipped: ClippedItem[] = [];
    const seen = new Set<string>();

    function record(
      element: Element,
      axis: ClipAxis,
      reason: ClipReason,
      ancestor?: Element
    ): void {
      const entry: ClippedItem = { selector: name(element), text: textOf(element), axis, reason };
      if (ancestor !== undefined) {
        entry.ancestor = name(ancestor);
      }
      const key = JSON.stringify(entry);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      clipped.push(entry);
    }

    const outside: OutsideItem[] = [];

    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const text = textOf(element);

      if (
        rect.left < -VIEWPORT_TOLERANCE ||
        rect.top < -VIEWPORT_TOLERANCE ||
        rect.right > window.innerWidth + VIEWPORT_TOLERANCE ||
        rect.bottom > window.innerHeight + VIEWPORT_TOLERANCE
      ) {
        outside.push({
          selector: name(element),
          text,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left
          }
        });
      }

      let ancestor = element.parentElement;
      while (ancestor !== null && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        const clientLeft = box.left + ancestor.clientLeft;
        const clientTop = box.top + ancestor.clientTop;

        if (hidesOverflow(style.overflowX)) {
          const clippedLeft = rect.left < clientLeft - CLIP_TOLERANCE;
          const clippedRight = rect.right > clientLeft + ancestor.clientWidth + CLIP_TOLERANCE;
          if (clippedLeft || clippedRight) {
            record(element, 'x', 'ancestor', ancestor);
          }
        } else if (scrollsOverflow(style.overflowX) && !isDocumentLevel(ancestor)) {
          if (ancestor.scrollWidth > ancestor.clientWidth + SCROLL_TOLERANCE) {
            record(element, 'x', 'scroll', ancestor);
          }
        }

        if (hidesOverflow(style.overflowY)) {
          const clippedTop = rect.top < clientTop - CLIP_TOLERANCE;
          const clippedBottom = rect.bottom > clientTop + ancestor.clientHeight + CLIP_TOLERANCE;
          if (clippedTop || clippedBottom) {
            record(element, 'y', 'ancestor', ancestor);
          }
        } else if (scrollsOverflow(style.overflowY) && !isDocumentLevel(ancestor)) {
          if (ancestor.scrollHeight > ancestor.clientHeight + SCROLL_TOLERANCE) {
            record(element, 'y', 'scroll', ancestor);
          }
        }

        ancestor = ancestor.parentElement;
      }

      const own = getComputedStyle(element);
      if (
        hidesOverflow(own.overflowX) &&
        element.scrollWidth > element.clientWidth + SCROLL_TOLERANCE
      ) {
        record(element, 'x', 'self');
      }
      if (
        hidesOverflow(own.overflowY) &&
        element.scrollHeight > element.clientHeight + SCROLL_TOLERANCE
      ) {
        record(element, 'y', 'self');
      }
    }

    const content = document.querySelector('.content');
    const scrolling = document.scrollingElement ?? document.documentElement;
    const tiles = Array.from(document.querySelectorAll('ul.tiles li.tile')).map(
      (tile): TileSize => {
        const rect = tile.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }
    );

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: scrolling.scrollWidth,
      docScrollHeight: scrolling.scrollHeight,
      contentClientHeight: content?.clientHeight ?? 0,
      contentScrollHeight: content?.scrollHeight ?? 0,
      contentScrollTop: content?.scrollTop ?? 0,
      tiles,
      clipped,
      outside
    };
  });
}

/** Assert a layout report is healthy, attaching the whole report on failure. */
function expectHealthyLayout(report: LayoutReport): void {
  const detail = `layout report: ${JSON.stringify(report)}`;
  expect({ clipped: report.clipped, outside: report.outside }, detail).toEqual({
    clipped: [],
    outside: []
  });
  expect(report.docScrollHeight, detail).toBeLessThanOrEqual(report.innerHeight + 1);
  expect(report.docScrollWidth, detail).toBeLessThanOrEqual(report.innerWidth + 1);
  expect(report.contentScrollHeight, detail).toBeLessThanOrEqual(report.contentClientHeight + 1);
  expect(report.contentScrollTop, detail).toBe(0);
}

/** A rendered border box, as the header measurements compare it. */
interface HeaderBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** The header's two gutters and the panel around them (cd-qvt2), in one read. */
interface HeaderGeometry {
  innerWidth: number;
  innerHeight: number;
  header: HeaderBox;
  tools: HeaderBox;
  clock: HeaderBox;
  firstTile: HeaderBox;
  docScrollWidth: number;
  docScrollHeight: number;
}

/**
 * Read the header geometry in one evaluation.
 *
 * The direct-child selectors are the point: the clock used to be a pill *inside*
 * `.tools`, and only `.header > time.clock` can tell the two structures apart.
 * A missing element throws instead of being skipped, so a header that lost its
 * clock fails loudly rather than reporting `NaN` boxes.
 */
async function headerGeometry(page: Page): Promise<HeaderGeometry> {
  return await page.evaluate((): HeaderGeometry => {
    function boxOf(element: Element): HeaderBox {
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

    const header = document.querySelector('.header');
    const tools = document.querySelector('.header > .tools');
    const clock = document.querySelector('.header > time.clock');
    const firstTile = document.querySelector('ul.tiles li.tile');
    if (header === null || tools === null || clock === null || firstTile === null) {
      throw new Error('the kiosk header must have .tools, its own time.clock and a first tile');
    }
    const scrolling = document.scrollingElement ?? document.documentElement;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      header: boxOf(header),
      tools: boxOf(tools),
      clock: boxOf(clock),
      firstTile: boxOf(firstTile),
      docScrollWidth: scrolling.scrollWidth,
      docScrollHeight: scrolling.scrollHeight
    };
  });
}

test('no page scroll and no clipped text at 1024x600, 1920x1080 and 3840x2160', async ({ page }) => {
  const viewports = [
    { width: 1024, height: 600, tiles: 4, chimes: 1 },
    { width: 1920, height: 1080, tiles: 9, chimes: 4 },
    { width: 3840, height: 2160, tiles: 9, chimes: 4 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDashboard(page, { tiles: viewport.tiles, chimes: viewport.chimes });

    const report = await layoutReport(page);
    expect(report.innerWidth).toBe(viewport.width);
    expect(report.innerHeight).toBe(viewport.height);
    expectHealthyLayout(report);

    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop)
    ).toBe(0);

    expect(report.tiles).toHaveLength(viewport.tiles);
    for (const size of report.tiles) {
      expect(size.width, JSON.stringify(report.tiles)).toBeGreaterThan(100);
      expect(size.height, JSON.stringify(report.tiles)).toBeGreaterThanOrEqual(56);
    }
  }
});

test('kiosk chrome: the rail keeps settings reachable, appliance flags, context menu suppressed', async ({ page }) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await expect(page.locator('html')).toHaveAttribute('data-kiosk', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'dashboard');
  // The masthead is decoration and goes; the rail's settings link is functional
  // and stays, because a kiosk with no way into settings is a trap (HSD-snsm).
  await expect(page.locator('h1.product')).toHaveCount(0);
  await expect(page.locator('[data-testid="rail-settings"]')).toHaveCount(1);

  expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).toBe('none');

  // Pull-to-refresh and double-tap zoom are CSS contracts: the viewport is
  // fixed, overscroll is off and touch gestures are limited to manipulation.
  const appliance = await page.evaluate(() => ({
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
    bodyTouchAction: getComputedStyle(document.body).touchAction,
    bodyOverflow: getComputedStyle(document.body).overflow
  }));
  expect(appliance.htmlOverscroll).toBe('none');
  expect(appliance.bodyOverscroll).toBe('none');
  expect(appliance.bodyTouchAction).toBe('manipulation');
  expect(appliance.bodyOverflow).toBe('hidden');

  const prevented = await page.evaluate(() => {
    const target = document.querySelector('.content');
    if (target === null) {
      return null;
    }
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
});

test('cursor hides after 5 s of inactivity and returns on pointer movement', async ({ page }) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await page.mouse.move(200, 200);
  expect(await page.locator('html').getAttribute('data-cursor')).toBeNull();
  expect(
    await page.locator('li.tile').first().evaluate((element) => getComputedStyle(element).cursor)
  ).not.toBe('none');

  await expect(page.locator('html')).toHaveAttribute('data-cursor', 'hidden', { timeout: 10_000 });
  expect(
    await page.locator('li.tile').first().evaluate((element) => getComputedStyle(element).cursor)
  ).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('none');

  await page.mouse.move(300, 250);
  await expect(page.locator('html')).not.toHaveAttribute('data-cursor', 'hidden', {
    timeout: 2_000
  });
  expect(
    await page.locator('li.tile').first().evaluate((element) => getComputedStyle(element).cursor)
  ).not.toBe('none');
});

test('cursor stays visible while a sheet is open', async ({ page }) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await page.mouse.move(200, 200);
  // Any sheet keeps the cursor: the health sheet replaced the retired volume
  // sheet, so it is the surface this policy is proven on now.
  await page.locator('button.status').click();
  await expect(page.locator('dialog.sheet[open]')).toBeVisible();

  // Five seconds is the idle window; six proves it fired at least once.
  await page.waitForTimeout(6000);
  expect(await page.locator('html').getAttribute('data-cursor')).toBeNull();

  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sheet[open]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-cursor', 'hidden', { timeout: 10_000 });
});

test('reduced motion removes transitions', async ({ page }) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(
      async () =>
        page.evaluate(() => ({
          card: getComputedStyle(document.querySelector('li.tile .card') as Element)
            .transitionDuration,
          // `.chime-btn` was removed with the chime strip under D29. The rail's
          // controls are the dashboard's remaining always-present transition.
          rail: getComputedStyle(document.querySelector('.rail .control') as Element)
            .transitionDuration
        })),
      { timeout: 5_000 }
    )
    .toMatchObject({ card: '0.12s', rail: '0.12s' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(
      async () =>
        page.evaluate(() => ({
          card: getComputedStyle(document.querySelector('li.tile .card') as Element)
            .transitionDuration,
          // Replaces the removed `.chime-btn` probe (D29 deleted the chime strip).
          rail: getComputedStyle(document.querySelector('.rail .control') as Element)
            .transitionDuration,
          dot: getComputedStyle(document.querySelector('.dot') as Element).animationDuration,
          motionFast: getComputedStyle(document.documentElement)
            .getPropertyValue('--motion-fast')
            .trim()
        })),
      { timeout: 5_000 }
    )
    .toMatchObject({ card: '0s', rail: '0s', dot: '0s' });

  // The built CSS minifier canonicalises zero time values (`0ms` → `0s`), so
  // accept either spelling; the assertion is that the token is a zero duration.
  expect(['0s', '0ms']).toContain(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim()
    )
  );
});

test('reload during a network blip restores the snapshot, marked stale, then recovers', async ({
  page
}) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await expect
    .poll(
      async () => page.evaluate(() => localStorage.getItem('doorbell.snapshot') !== null),
      { timeout: 5_000 }
    )
    .toBe(true);
  const cached = await page.evaluate(() => {
    const raw = localStorage.getItem('doorbell.snapshot');
    return raw === null ? null : (JSON.parse(raw) as { v?: unknown });
  });
  expect(cached).not.toBeNull();
  expect(cached?.v).toBe(1);

  await setHarnessState(page.request, { online: false });
  await page.reload();

  await expect(page.getByText('Waiting for live data')).toHaveCount(0);
  await expect(page.locator('ul.tiles li.tile')).toHaveCount(4);
  await expect(page.locator('li.tile[data-stale="true"]')).toHaveCount(4);
  await expect(page.locator('li.tile[data-stale="true"] .stale')).toHaveCount(4);
  await expect(page.locator('li.tile[data-stale="true"] .stale').first()).toBeVisible();
  await expect(page.locator('.page[data-restored="true"]')).toHaveCount(1);
  await expect(page.getByText('Showing last known state')).toBeVisible();

  expect(await page.locator('[data-connection-state]').first().getAttribute('data-connection-state')).not.toBe('live');
  const connectionWord = (await page.locator('.connection-text').first().textContent())?.trim();
  expect(connectionWord).not.toBe('Live');

  await setHarnessState(page.request, { online: true });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(page.locator(LIVE_TILE).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.stale')).toHaveCount(0);
  await expect(page.getByText('Showing last known state')).toHaveCount(0);
  await expect(page.locator('.page[data-restored="true"]')).toHaveCount(0);
});

test('reload while the API hangs still paints the cached tiles', async ({ page }) => {
  await openDashboard(page, { tiles: 4, chimes: 1 });

  await expect
    .poll(
      async () => page.evaluate(() => localStorage.getItem('doorbell.snapshot') !== null),
      { timeout: 5_000 }
    )
    .toBe(true);

  // The worst blip: the backend accepts the connection and never answers, so
  // `settings.load()` cannot resolve. Without the bounded wait the panel would
  // stay blank forever on reload; with it the cached tiles must appear.
  await setHarnessState(page.request, { hang: true });
  const startedAt = Date.now();
  await page.reload();

  await expect(page.locator('ul.tiles li.tile')).toHaveCount(4, { timeout: 6_000 });
  expect(Date.now() - startedAt, 'cached tiles must paint without waiting for settings').toBeLessThan(
    6_000
  );

  await setHarnessState(page.request, { hang: false, online: true });
});

test('in kiosk mode the gear opens settings', async ({ page }) => {
  // The regression HSD-snsm fixes: the old header hid its settings button in
  // kiosk mode, so the wall panel could not reach settings at all.
  await page.goto('/?kiosk=1');
  const gear = page.locator('[data-testid="rail-settings"]');
  await expect(gear).toBeVisible();

  await gear.click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'page');
  // The rail belongs to the dashboard shell, not the settings shell.
  await expect(page.locator('[data-testid="control-rail"]')).toHaveCount(0);
});

test('settings route still scrolls', async ({ page }) => {
  await page.goto('/settings');

  await expect(page.locator('html')).toHaveAttribute('data-layout', 'page');
  await expect(page.locator('html')).not.toHaveAttribute('data-kiosk', 'true');

  const overflow = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflow,
    bodyY: getComputedStyle(document.body).overflowY
  }));
  expect(overflow.html).not.toBe('hidden');
  expect(overflow.bodyY).not.toBe('hidden');
});

test('the kiosk URL survives a reload', async ({ page }) => {
  await page.goto('/?kiosk=1');
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-kiosk', 'true');

  await page.reload();
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-kiosk', 'true');
  await expect(page.locator('[data-testid="rail-settings"]')).toHaveCount(1);

  await page.goto('/?setup=done&kiosk=1');
  await expect(page.getByText('Setup complete.')).toBeVisible();
  await expect.poll(() => page.url(), { timeout: 5_000 }).not.toContain('setup=done');
  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain('kiosk=1');
  await expect(page.locator('html')).toHaveAttribute('data-kiosk', 'true');
});

test('the settings shell returns to the kiosk dashboard', async ({ page }) => {
  // HSD-h44d: the cage has no address bar, no tabs and no back button, so a
  // wall panel that enters settings must carry its own way home — and coming
  // back must stay in kiosk mode, which a full navigation re-derives from
  // sessionStorage.
  await page.goto('/?kiosk=1');

  const gear = page.locator('[data-testid="rail-settings"]');
  await expect(gear).toBeVisible();
  await gear.click();

  await expect(page.locator('html')).toHaveAttribute('data-layout', 'page');
  // D28 unchanged: the settings shell draws no rail of its own.
  await expect(page.locator('[data-testid="control-rail"]')).toHaveCount(0);

  await page.locator('a[href="/settings/audio"]').click();
  await expect(page).toHaveURL(/\/settings\/audio$/);

  await page.locator('[data-testid="back-to-dashboard"]').click();

  // The root, and no `?kiosk` on the URL: the flag has to come back from the
  // session store, not from a query the link could have forgotten.
  await expect(page).toHaveURL(/\/$/);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).search).toBe('');

  await expect(page.locator('html')).toHaveAttribute('data-kiosk', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'dashboard');
  expect(await page.evaluate(() => sessionStorage.getItem('doorbell.kiosk'))).toBe('1');
  await expect(page.locator('[data-testid="rail-settings"]')).toBeVisible();
});

/**
 * cd-qvt2: the kiosk header is title-less and has always kept its pills on the
 * left; what was wrong is that the clock came with them. It used to live inside
 * `.tools`, so a `space-between` header had one child and the clock bunched up
 * next to the status dots (right edge 813 at 1280x720, the regression this test
 * exists to catch). Now it is `.header`'s own child, pinned to the right gutter
 * by its auto margin in both modes.
 *
 * `expectHealthyLayout` is deliberately not reused here, though this test is
 * about layout: it also asserts `.content` never scrolls. At 320x568 a
 * single-column six-tile grid legitimately does scroll — that is the documented
 * safety valve, not a header failure — so reusing it would either fail a
 * healthy header or force a weakening of the shared helper. Neither is
 * acceptable, so this test measures the document and the header itself and
 * leaves `expectHealthyLayout` exactly as it is.
 */
test('cd-qvt2: the kiosk header keeps the pills left and the clock on the right gutter', async ({
  page
}) => {
  // Five page loads against the fake harness; the same headroom argument as the
  // landscape layout test above.
  test.setTimeout(120_000);

  /** `--gap`: the same 16px gutter the tile grid spends. */
  const GUTTER = 16;
  /**
   * `getBoundingClientRect()` returns fractions of a layout px, so every
   * assertion allows ±1px. A real 15px or 17px gutter still fails; a looser
   * bound would stop proving 16 at all.
   */
  const TOLERANCE = 1;
  /** The pre-existing header height and first-tile top at landscape panels. */
  const LANDSCAPE_HEADER_HEIGHT = 80;
  const LANDSCAPE_FIRST_TILE_TOP = 96;

  const viewports = [
    { width: 1280, height: 720 }, // the reference panel, the size the owner measured
    { width: 1024, height: 600 }, // the wall panel
    { width: 1920, height: 1080 },
    { width: 720, height: 1280 }, // portrait: the clock's own row
    { width: 320, height: 568 } // the narrowest case the wrap has to survive
  ];

  for (const viewport of viewports) {
    const label = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDashboard(page, { tiles: 6, chimes: 0 });

    // The wall stays title-less, and the clock is a `.header` child, not a pill:
    // a clock still inside `.tools` fails the second count even though every box
    // below could look plausible.
    await expect(page.locator('h1.product'), `the kiosk gained a title — ${label}`).toHaveCount(0);
    await expect(page.locator('.header > .tools'), `no .tools child — ${label}`).toHaveCount(1);
    await expect(page.locator('.header > time.clock'), `no own time.clock — ${label}`).toHaveCount(
      1
    );

    const geometry = await headerGeometry(page);

    const clockInset = geometry.innerWidth - geometry.clock.right;
    const firstTileTop = geometry.firstTile.top;
    // The rectangles intersect on both axes: the clock painting over a pill.
    const overlaps =
      geometry.clock.right > geometry.tools.left + TOLERANCE &&
      geometry.clock.left < geometry.tools.right - TOLERANCE &&
      geometry.clock.bottom > geometry.tools.top + TOLERANCE &&
      geometry.clock.top < geometry.tools.bottom - TOLERANCE;
    const detail =
      `kiosk header at ${label}: tools ${geometry.tools.left.toFixed(2)}→` +
      `${geometry.tools.right.toFixed(2)}, clock ${geometry.clock.left.toFixed(2)}→` +
      `${geometry.clock.right.toFixed(2)} (top ${geometry.clock.top.toFixed(2)}, ` +
      `bottom ${geometry.clock.bottom.toFixed(2)}), header h ` +
      `${geometry.header.height.toFixed(2)}, first tile top ${firstTileTop.toFixed(2)}, ` +
      `doc scroll ${geometry.docScrollWidth}x${geometry.docScrollHeight} vs ` +
      `${geometry.innerWidth}x${geometry.innerHeight}`;

    // Logged before the assertions, so a failure still prints the evidence.
    console.log(
      `cd-qvt2 kiosk ${label}: tools left ${geometry.tools.left.toFixed(2)}, clock ` +
        `${geometry.clock.left.toFixed(2)}→${geometry.clock.right.toFixed(2)}, header h ` +
        `${geometry.header.height.toFixed(2)}, first tile top ${firstTileTop.toFixed(2)}, ` +
        `clock inset ${clockInset.toFixed(2)}, doc scroll ` +
        `${geometry.docScrollWidth}x${geometry.docScrollHeight}`
    );

    // The owner's decision: the pills stay on the left gutter, and the clock
    // takes the right one — exactly the viewport minus `--gap`.
    expect(
      Math.abs(geometry.tools.left - GUTTER),
      `the pills do not start on the ${GUTTER}px gutter — ${detail}`
    ).toBeLessThanOrEqual(TOLERANCE);
    expect(
      Math.abs(clockInset - GUTTER),
      `the clock's right edge is not on the ${GUTTER}px gutter — ${detail}`
    ).toBeLessThanOrEqual(TOLERANCE);

    // Nothing clipped and nothing off-screen: the wrap must move the clock to
    // another row, not push it past the edge.
    expect(geometry.clock.left, `the clock starts off-screen — ${detail}`).toBeGreaterThanOrEqual(0);
    expect(geometry.clock.right, `the clock ends off-screen — ${detail}`).toBeLessThanOrEqual(
      geometry.innerWidth
    );
    expect(geometry.clock.top, `the clock starts above the viewport — ${detail}`).toBeGreaterThanOrEqual(
      0
    );
    expect(
      geometry.clock.bottom,
      `the clock hangs below the header — ${detail}`
    ).toBeLessThanOrEqual(geometry.header.bottom + TOLERANCE);
    expect(overlaps, `the clock paints over the pills — ${detail}`).toBe(false);

    // A row that grew a second column instead of wrapping would scroll sideways,
    // and a header that outgrew the panel would scroll down.
    expect(
      geometry.docScrollWidth,
      `the document scrolls horizontally — ${detail}`
    ).toBeLessThanOrEqual(geometry.innerWidth + TOLERANCE);
    expect(
      geometry.docScrollHeight,
      `the document scrolls vertically — ${detail}`
    ).toBeLessThanOrEqual(geometry.innerHeight + TOLERANCE);

    if (viewport.width > viewport.height) {
      // The pre-existing numbers, re-asserted so the pin cannot buy itself
      // height: 80px of header puts the first tile 16px lower, at 96.
      expect(
        Math.abs(geometry.header.height - LANDSCAPE_HEADER_HEIGHT),
        `the landscape header is no longer ${LANDSCAPE_HEADER_HEIGHT}px — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(firstTileTop - LANDSCAPE_FIRST_TILE_TOP),
        `the first tile no longer starts at ${LANDSCAPE_FIRST_TILE_TOP}px — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    } else {
      // `.content`'s `padding-block: var(--gap)`. The measured kiosk header
      // heights are 126 at 720x1280, 270 at 480x800 and 334 at 320x568 — the
      // clock's wrapped row costs a header-level gap, and 480 sits between two
      // widths this list runs so a change there is recorded too. Below such a
      // header the first tile is one gap down; anything else moved the body.
      expect(
        Math.abs(firstTileTop - (geometry.header.bottom + GUTTER)),
        `the first tile is not one ${GUTTER}px gap below the header — ${detail}`
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  }
});
