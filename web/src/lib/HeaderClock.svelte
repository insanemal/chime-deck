<!--
  Header clock (design 05 §2): the wall panel's "is this thing alive" cue.

  Reads `settings.showClock` so the setting can turn it off without unmounting
  anything else, and ticks a `<time>` element once a second. `formatClock()` is
  locale-free on purpose (clock.ts): the panel and a test must print the same
  digits, and a locale-dependent time would make the tile look different after
  a language change.
-->
<script lang="ts">
  import { formatClock } from './clock.js';
  import { settings } from './settings.svelte.js';

  let now = $state(new Date());

  $effect(() => {
    // No timer while the clock is hidden: ticking to render nothing is pure
    // waste on a panel that runs for months. `settings.showClock` is read here
    // so the effect re-runs (and tears the timer down) when the setting flips.
    if (!settings.showClock) return;

    const interval = setInterval(() => {
      now = new Date();
    }, 1000);
    return () => clearInterval(interval);
  });

  const text = $derived(formatClock(now));
  const stamp = $derived(now.toISOString());
</script>

{#if settings.showClock}
  <time class="clock" datetime={stamp}>{text}</time>
{/if}

<style>
  /*
   * The header's inline end (cd-qvt2): the clock is a direct child of `.header`,
   * after the title and the pills, and the auto margin takes every bit of free
   * space — so the clock sits on the 16px right gutter in kiosk mode (no title)
   * exactly as it does in a browser. On a wrapped line it is the only item there,
   * and an auto margin right-aligns a lone item too. `flex: 0 0 auto` keeps the
   * digits whole: a shrunk clock would be a clipped clock.
   */
  .clock {
    margin-inline-start: auto;
    flex: 0 0 auto;
    font-family: var(--font-num);
    font-size: var(--text-title);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
</style>
