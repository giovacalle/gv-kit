# Dates

`@internationalized/date` is the **sole** date/time library. No `date-fns`, no `dayjs`, no `moment`, no `luxon`, no `spacetime`.

## Why

1. **Cloudflare Workers compatible** — pure JS, zero Node dependencies.
2. **Smallest bundle** (~2.8 kB for Gregorian-only usage).
3. **No locale bloat** — uses native `Intl.DateTimeFormat`, no locale files to ship.
4. **bits-ui / shadcn-svelte ready** — Calendar / DatePicker / DateField primitives expect `DateValue` types from this library.
5. **Future-proof** — modeled after the TC39 Temporal proposal.

## Core types

| Type | Use case | Example |
|---|---|---|
| `CalendarDate` | Date without time | `new CalendarDate(2026, 4, 19)` |
| `CalendarDateTime` | Date + time, no timezone | `new CalendarDateTime(2026, 4, 19, 12, 30)` |
| `ZonedDateTime` | Date + time + timezone | full TZ-aware datetime |
| `DateFormatter` | Locale-aware formatting | wraps `Intl.DateTimeFormat` |

> **Months are 1-based** (January = 1), unlike native JS `Date` (January = 0). Don't mix.

## Storage — epoch milliseconds

Databases store dates as `INTEGER` columns holding epoch milliseconds. With Drizzle on D1: `integer({ mode: 'timestamp_ms' })`.

For plain timestamp arithmetic, `Date.now()` is fine:

```typescript
const now = Date.now();
const sevenDaysLater = now + 7 * 24 * 60 * 60 * 1000;
```

For calendar math, DST-safe shifts, or weekday lookups, use `@internationalized/date`.

## Display formatting

Always use `DateFormatter` for user-facing dates. The locale is `'en-US'` — this app is EN-only.

```typescript
import { DateFormatter } from '@internationalized/date';

const formatter = new DateFormatter('en-US', { dateStyle: 'long' });
formatter.format(new Date(timestamp));
// "April 19, 2026"

const shortFormatter = new DateFormatter('en-US', { dateStyle: 'short', timeStyle: 'short' });
shortFormatter.format(new Date(timestamp));
// "4/19/26, 2:30 PM"
```

Reuse formatters when possible — they're cheap to construct but cheaper to keep around.

## Conversion helpers

When bridging a `CalendarDate` (e.g. from a DatePicker) to a DB timestamp, factor a tiny helper at the boundary. Don't pre-create one until a real need lands.

```typescript
// src/lib/utils/date.ts — only when something actually uses it
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date';

export function timestampToCalendarDate(ms: number): CalendarDate {
	const d = new Date(ms);
	// 1-based month here vs 0-based on JS Date.
	return new CalendarDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function calendarDateToTimestamp(cd: CalendarDate): number {
	return Date.UTC(cd.year, cd.month - 1, cd.day);
}

export function getToday(): CalendarDate {
	return today(getLocalTimeZone());
}
```

## Date picker integration

When a `DatePicker` primitive is added (`pnpm dlx shadcn-svelte@latest add date-picker` from `packages/ui`), bind to `CalendarDate` values on the component and convert at the edges:

```svelte
<script lang="ts">
	import type { CalendarDate } from '@internationalized/date';

	import { calendarDateToTimestamp, timestampToCalendarDate } from '$lib/utils/date';

	let { initialMs }: { initialMs?: number } = $props();
	let dateValue = $state<CalendarDate | undefined>(
		initialMs ? timestampToCalendarDate(initialMs) : undefined
	);

	const payloadMs = $derived(dateValue ? calendarDateToTimestamp(dateValue) : undefined);
</script>
```

## Anti-patterns

| Don't | Do |
|---|---|
| `import dayjs from 'dayjs'` | `@internationalized/date` |
| `import { format } from 'date-fns'` | `DateFormatter` |
| `moment(...)` | `@internationalized/date` |
| `luxon`, `spacetime`, etc. | `@internationalized/date` |
| `new Date().toLocaleDateString('en-US')` | `new DateFormatter('en-US', {...}).format(date)` |
| Hardcoded format strings (`MM/DD/YYYY`) | `DateFormatter` with a style option |
| Mixing 0-based JS `Date` months with 1-based `CalendarDate` | Convert explicitly at the boundary |
