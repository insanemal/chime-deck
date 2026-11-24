<!--
  The dashboard (D28, D29): the header is state only, the right-hand rail is
  the only control surface, and that rail is present in kiosk mode too. The
  main area is no longer read-only: it shows the configured tiles, and a tap
  on one toggles that entity's selection (D29) — that tap is the only thing a
  tile does.

  Kiosk mode drops only decoration: the brand masthead and the App shell's
  gradient. The clock, health dots, state badges and control rail stay because
  they are functional. Cursor hiding, no-scroll, autoplay and reduced-motion
  policy are HSD-0qtn, not this component.

  The grid is the reflow contract, horizontally and vertically:
  - the column count is the setting, or the tile count's own balanced divisor
    (4 → 2×2, 9 → 3×3), so a rectangle of tiles never leaves a third of a row
    empty the way an auto-fit of the panel width did at four tiles;
  - `minmax(max((100% - (N-1)·gap)/N, min(240px, 100%)), 1fr)` makes exactly N
    tracks fit, keeps design 05 §2.1's 240px floor when N would squeeze them,
    and never overflows a viewport narrower than 240px;
  - `repeat(auto-fit, …)` then collapses any track nothing lands in, so a lone
    tile fills its row;
  - vertically the grid takes the space `.content` has left and its rows share
    that height, so 2–3 tiles fill a 1280×720 panel instead of stacking at the
    top;
  - there is no max-width centring column: tiles own the whole content box in
    both axes, while the control rail stays on the right edge of `.body`;
  - the ≤639px media rule is the single-column contract and sits LAST.
-->
<script lang="ts">
  import { ApiError, toggleTileSelection, type EntityTile } from './api.js';
  import { liveState } from './stores.svelte.js';
  import { settings } from './settings.svelte.js';
  import { tileView } from './tile-view.js';
  import { toastStore } from './ui/toast.svelte.js';
  import ControlRail from './ControlRail.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import HeaderBadges from './HeaderBadges.svelte';
  import HeaderClock from './HeaderClock.svelte';
  import StatusDots from './StatusDots.svelte';
  import Tile from './Tile.svelte';

  interface Props {
    kiosk?: boolean;
  }

  let { kiosk = false }: Props = $props();

  const columns = $derived(settings.dashboardColumns);
  const tiles = $derived(liveState.entities.filter((tile) => !tileView(tile).hidden));

  /**
   * The column count for an automatic arrangement: the tile count's own
   * square-ish divisor, so the grid is a full rectangle whenever the count allows
   * one (4 → 2×2, 6 → 2×3, 9 → 3×3) instead of the 3+1 that an auto-fit of the
   * panel width gives at four tiles — the empty third of the last row this ticket
   * exists to remove. A prime count has no divisor below itself, so the search
   * ends on the count itself and the 240px track floor narrows that to what
   * fits.
   */
  function balancedColumns(count: number): number {
    const root = Math.max(1, Math.ceil(Math.sqrt(count)));
    for (let candidate = root; candidate <= count; candidate += 1) {
      if (count % candidate === 0) {
        return candidate;
      }
    }
    return root;
  }

  /** The column count the grid actually uses: the setting, or a balanced auto count. */
  const effectiveColumns = $derived(columns > 0 ? columns : balancedColumns(tiles.length));

  /**
   * Toggle one tile's selection. The store is flipped first so the tap is
   * instant (D29); the request is the reconciliation, not the paint.
   */
  async function toggle(tile: EntityTile): Promise<void> {
    const previous = tile.selected;
    const wanted = !previous;
    liveState.setSelected(tile.entityId, wanted);
    try {
      const answer = await toggleTileSelection(tile.id);
      // The server toggles, so its answer normally agrees with the optimistic
      // value and this is a no-op. Only a disagreement is applied: a slow reply
      // must not overwrite a newer tap's optimistic value.
      if (typeof answer.selected === 'boolean' && answer.selected !== wanted) {
        liveState.setSelected(tile.entityId, answer.selected);
      }
    } catch (cause) {
      // The tap failed, so the user is told — unconditionally. A broadcast that
      // moved the value under us is the server speaking, not a newer tap: it is
      // a reason to skip the revert, never a reason to swallow the failure.
      toastStore.push(
        'error',
        cause instanceof ApiError ? cause.message : 'the selection could not be saved'
      );
      // Only the revert is conditional: when the store no longer holds this
      // tap's optimistic value a newer tap (or a broadcast) owns it, and undoing
      // it would discard that.
      if (liveState.isSelected(tile.entityId) === wanted) {
        liveState.setSelected(tile.entityId, previous);
      }
    }
  }
</script>

<div class="page" data-kiosk={kiosk ? 'true' : undefined} data-restored={liveState.restoredFromCache ? 'true' : undefined}>
  <header class="header">
    {#if !kiosk}
      <h1 class="product">ChimeDeck</h1>
    {/if}

    <div class="tools">
      <StatusDots />
      <HeaderBadges />
    </div>
    <HeaderClock />
  </header>

  <div class="body">
    <main class="content">
      {#if liveState.restoredFromCache}
        <p class="restored" role="status">Showing last known state</p>
      {/if}
      {#if !liveState.hasSnapshot}
        <EmptyState icon="mdi:door" title="Waiting for live data" />
      {:else if tiles.length === 0}
        <EmptyState
          icon="mdi:door"
          title="No status tiles configured"
          description="Open the settings gear in the control rail to add your first tile."
        />
      {:else}
        <ul
          class="tiles"
          data-columns={columns || undefined}
          style={`--tiles-columns: ${effectiveColumns}`}
          aria-label="Status tiles"
        >
          {#each tiles as tile (tile.entityId)}
            <Tile {tile} stale={liveState.stale} ontoggle={(tapped) => void toggle(tapped)} />
          {/each}
        </ul>
      {/if}
    </main>
    <ControlRail />
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  /*
   * The header spends the same 16px gutter as the tile grid: the title (browser
   * only) and the status pills sit on the left gutter, and the clock pins the
   * right one (cd-qvt2 — `.clock`'s own `margin-inline-start: auto` does the
   * pinning, so the title's presence cannot move it). The horizontal gutter used
   * to be `clamp(var(--gap), 3vw, calc(var(--gap) * 2))`, which is 32px at
   * 1280 — that is why the title never lined up with the grid. The vertical
   * padding is the same token now, so no ad-hoc `1.6vh` value is left in the
   * dashboard.
   *
   * `flex-start`, not the `space-between` that used to be here: the clock's auto
   * margin owns the row's free space, so space-between has nothing left to
   * distribute — and with `ui.show_clock` off the header is the title plus
   * `.tools` only, where space-between would throw browser-mode pills to the
   * right but leave the kiosk ones at the left. One layout in both modes.
   */
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: var(--gap);
    width: 100%;
    min-height: var(--tap-primary);
    padding: var(--gap);
  }

  .product {
    margin: 0;
    font-size: var(--text-title);
    line-height: 1.2;
    font-weight: 700;
    color: var(--text);
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap);
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    /*
     * cd-bdjz, the owner's ruling: every horizontal gutter is 16px — one
     * `--gap` — and the rail's width is derived from it. The inline-start 16px
     * is the gutter from the screen edge to the first tile. The inline-end 0 is
     * not a missing gutter: the 16px between the grid's right edge and the rail
     * control is the rail's own inline padding (see ControlRail.svelte), and
     * counting it here as well would spend the width twice and take 16px off
     * every tile. The vertical padding is the same token, replacing
     * `clamp(12px, 2.4vh, 48px)`.
     */
    padding-block: var(--gap);
    padding-inline: var(--gap) 0;
    /*
     * A hidden internal scroller is the safety valve for a pathological tile
     * count; normal configurations fit the panel without it. The three-
     * resolution browser test asserts this scroller never scrolls in the
     * supported sizes, so it is a fallback, not a design.
     */
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }

  .content::-webkit-scrollbar {
    display: none;
  }

  .restored {
    margin: 0 0 var(--gap);
    font-size: var(--text-label);
    color: var(--text-muted);
    text-align: center;
  }

  /*
   * One declaration, counted: the grid's column count is the setting, or the
   * balanced auto count of the tile count, handed over as `--tiles-columns`.
   *
   * The arithmetic: `auto-fit`'s repetition count includes the gutters, because
   * N tracks of minimum `m` plus the (N-1) gaps between them has to fit the
   * container — `N·m + (N-1)·g ≤ W`. A track minimum of `W/N` therefore fits
   * only `N-1` tracks, and the last one collapses. Asking each track for
   * `(W - (N-1)·g)/N` makes `N·(W - (N-1)·g)/N + (N-1)·g` exactly `W`, so
   * exactly N tracks fit at every width.
   *
   * `max(..., min(240px, 100%))` is design 05 §2.1's track floor: when N would
   * squeeze a track below 240px the floor wins, `auto-fit` collapses the empty
   * tracks, and neither the automatic nor a forced count can produce a sliver —
   * 6 columns on a 952px panel gives 3 wide tracks, and a lone tile fills its
   * row. The `100%` cap keeps a single track from exceeding the container on a
   * narrow panel. The `3` fallback on `var()` keeps the declaration valid when
   * the inline property is missing entirely (a bare `ul.tiles` in a test):
   * an unresolvable `var()` would be invalid at computed-value time and drop
   * the property to its initial `none`, not to an earlier declaration.
   *
   * Vertically the rows share the height instead of sizing to content, and the
   * row floor is `var(--tap-primary)`: `minmax(tap, 1fr)`, so a row grows into
   * free space but never shrinks below a tappable target. The floor is D26's tap
   * size, so a grid that needs more rows than the panel has height for makes
   * `.content` scroll — the documented valve, above — instead of collapsing its
   * rows below the tap floor and letting each `.card`, whose `min-height` is the
   * same token, overflow its own tile. At 100% the floor never binds, because
   * the rows are already taller than it, so this is a no-op until a scale step
   * or a denser grid needs it. `flex: 1` (not `height: 100%`) makes the grid
   * claim what a `.restored` note leaves over.
   */
  /* Columns follow tile count and available space, never screen size; fixed breakpoints or aspect ratios regress resolution- and aspect-ratio-agnostic grid sizing. */
  .tiles {
    display: grid;
    /* one track per column, never narrower than design 05 §2.1's 240px floor */
    grid-template-columns: repeat(
      auto-fit,
      minmax(
        max(
          calc((100% - var(--gap) * (var(--tiles-columns, 3) - 1)) / var(--tiles-columns, 3)),
          min(240px, 100%)
        ),
        1fr
      )
    );
    grid-auto-rows: minmax(var(--tap-primary), 1fr);
    align-content: stretch;
    flex: 1;
    gap: var(--gap);
    min-height: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /*
   * The single-column contract, and it comes last. The repeated
   * `[data-columns]` selector is deliberate: an attribute selector outranks a
   * bare `.tiles`, so without it a forced count would survive on a phone. Both
   * declarations mean one column; source order settles the tie.
   */
  @media (max-width: 639px) {
    .tiles,
    .tiles[data-columns] {
      grid-template-columns: 1fr;
    }
  }
</style>
