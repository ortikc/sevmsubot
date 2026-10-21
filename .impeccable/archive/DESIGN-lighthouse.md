---
name: Расписание МГУ Севастополь
description: A student's own timetable inside Telegram, drawn as one warm lamp on a night-sea navy ground.
colors:
  lamp: "#FFD27A"
  lamp-ink: "#2A1E05"
  sea-0: "#071026"
  sea-1: "#0A1430"
  sea-2: "#12224B"
  sea-3: "#1A2C5C"
  sea-4: "#253A75"
  sea-5: "#36508F"
  ink: "#EAF0FF"
  ink-2: "#BAC7EB"
  ink-3: "#8FA2D1"
  alert: "#FF9C8F"
typography:
  display:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title-sm:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.3
  body-lg:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.4
  body:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.4
  lead:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  button:
    fontFamily: "Golos Text, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  figure-xl:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  figure:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  figure-day:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  figure-sm:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
rounded:
  tick: "2px"
  bar: "3px"
  track: "6px"
  sm: "8px"
  day: "12px"
  md: "14px"
  card: "16px"
  sheet: "20px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  control: "14px"
  inset: "16px"
  card: "18px"
  gutter: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sea-1}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: "54px"
    width: "100%"
  button-quiet:
    backgroundColor: "{colors.sea-3}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: "54px"
    width: "100%"
  icon-button:
    textColor: "{colors.ink-3}"
    rounded: "{rounded.sm}"
    width: "36px"
    height: "30px"
  icon-button-pressed:
    backgroundColor: "{colors.sea-2}"
  choice-item:
    backgroundColor: "{colors.sea-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
    height: "54px"
  choice-item-pressed:
    backgroundColor: "{colors.sea-3}"
  choice-item-selected:
    backgroundColor: "{colors.sea-3}"
  course-tile:
    backgroundColor: "{colors.sea-2}"
    textColor: "{colors.ink}"
    typography: "{typography.figure-xl}"
    rounded: "{rounded.md}"
    height: "76px"
  course-tile-selected:
    backgroundColor: "{colors.sea-3}"
  input-field:
    backgroundColor: "{colors.sea-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "54px"
  field-error:
    textColor: "{colors.alert}"
    typography: "{typography.label}"
  lamp-card:
    backgroundColor: "{colors.sea-2}"
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.card}"
    padding: "18px 18px 16px"
  status-dot:
    backgroundColor: "{colors.sea-5}"
    rounded: "{rounded.full}"
    size: "9px"
  status-dot-on:
    backgroundColor: "{colors.lamp}"
  light-track:
    backgroundColor: "{colors.sea-2}"
    rounded: "{rounded.track}"
    height: "12px"
  flash-upcoming:
    backgroundColor: "{colors.sea-5}"
    rounded: "{rounded.bar}"
    height: "12px"
  flash-past:
    backgroundColor: "{colors.sea-4}"
  flash-lit:
    backgroundColor: "{colors.lamp}"
  now-marker:
    backgroundColor: "{colors.ink}"
    width: "2px"
    height: "24px"
  pair-row:
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    padding: "13px 4px"
  pair-row-past:
    textColor: "{colors.ink-3}"
  break-row:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    padding: "10px 4px"
  week-bar:
    backgroundColor: "{colors.sea-0}"
    padding: "8px 8px 10px"
  day-tab:
    textColor: "{colors.ink-3}"
    typography: "{typography.caption}"
    rounded: "{rounded.day}"
    padding: "7px 0 9px"
  day-tab-selected:
    backgroundColor: "{colors.sea-3}"
    textColor: "{colors.ink-2}"
  day-numeral:
    textColor: "{colors.ink}"
    typography: "{typography.figure-day}"
  day-numeral-today:
    textColor: "{colors.lamp}"
  day-tick:
    backgroundColor: "{colors.sea-5}"
    rounded: "{rounded.tick}"
    width: "5px"
    height: "4px"
  day-tick-selected:
    backgroundColor: "{colors.lamp}"
  progress-segment:
    backgroundColor: "{colors.sea-3}"
    rounded: "{rounded.bar}"
    width: "26px"
    height: "6px"
  progress-segment-on:
    backgroundColor: "{colors.lamp}"
  avatar:
    backgroundColor: "{colors.sea-4}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    size: "42px"
  avatar-lg:
    size: "84px"
  sheet-panel:
    backgroundColor: "{colors.sea-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "10px 20px 22px"
  info-rows:
    backgroundColor: "{colors.sea-2}"
    textColor: "{colors.ink}"
    typography: "{typography.lead}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
---

# Design System: Расписание МГУ Севастополь

## Overview

**Creative North Star: "One Lamp on the Night Sea"**

The app is the Chersonesos lighthouse after dark. A deep navy sea holds everything: ground, surfaces, dividers and the dim marks of things not happening now, all stepped from one cold hue (OKLCH hue ≈265–269°). Porcelain ink carries the language. One warm lamp, amber, appears only where something is lit: the pair running now, today's date, whatever the student has just chosen, the control that has focus. A screen with no amber on it is a screen where nothing is happening.

Density is phone-first and one-handed. One column on a 20px gutter, 54px controls, a fixed week strip under the thumb. Information is quiet by default (13px meta in Fog, 1px hairlines) so the lit card and the figures can carry the weight. Every clock time, room, date and group code is set in tabular JetBrains Mono, so the timetable reads like an instrument panel and not a stack of equal cards. The world refuses the category default: a flat list of identical cards with a blue accent.

Motion behaves like light, not like choreography. Day segments flash in left to right on a 70ms stagger, the running pair's glow breathes on a 4-second beam, the loading dot pulses like a beacon. Everything is touch-first: pressed states replace hover. Under reduced motion the whole system goes still, and the lit pair keeps a static glow.

**Key Characteristics:**
- A six-step night-sea navy ramp (sea-0 to sea-5) for ground, surfaces, dividers and idle marks.
- One accent, Lamp Amber, used only as a mark (bars, dots, 2px rings, numerals, outlines), never as a fill.
- Porcelain ink in three steps (ink, ink-2, ink-3) for all text.
- Golos Text for words, JetBrains Mono with tabular figures for every figure.
- Depth from tonal steps of navy; the bottom sheet is the only lifted layer.
- A 14px corner family; selection drawn as an inset 2px amber ring.
- Touch-first states: press scale, `aria-pressed`, `:focus-visible`. No hover.

## Colors

A cold, single-hue navy world with exactly one warm accent and one warm error signal.

### Primary
- **Lamp Amber** (#FFD27A): the only accent, and it marks rather than fills. It appears on the running pair's flash on the light strip (with its glow), the status dot in the lamp card, today's date numeral in the week strip, the ticks under the selected day, onboarding progress segments that are done, the inset ring on a selected choice or course tile and on a focused input, the `:focus-visible` outline, the loading beacon, the input caret and text selection. 12.8:1 on Night Sea.
- **Lamp Ink** (#2A1E05): dark umber for text set on amber. Currently used only for `::selection` text (11.5:1 on Lamp Amber).

### Neutral
- **Abyss** (#071026): the deepest step. Ground of the fixed week strip and Telegram's bottom bar colour.
- **Night Sea** (#0A1430): the page ground, the bottom sheet, Telegram header and background colour, `theme-color`, and the text colour on the primary button.
- **Deep Water** (#12224B): the first surface step. Lamp card, choice rows, course tiles, the input, the onboarding summary, profile rows, the light strip's track. On the Night Sea ground it is also the hairline between list rows and under the week strip.
- **Swell** (#1A2C5C): the second step. Pressed and selected surfaces (selected choice, selected course, selected day tab, quiet button), hairlines inside a Deep Water surface, onboarding progress segments not yet reached.
- **Harbour Navy** (#253A75): avatar fill, the input's 1px resting ring, past flashes on the light strip, the sheet grabber.
- **Unlit Navy** (#36508F): the brightest navy, for marks that are present but not lit: upcoming flashes, pair-count ticks on unselected days, the idle status dot. Only 2:1 against Deep Water, so it never carries text.
- **Porcelain** (#EAF0FF): primary text, the primary button fill, the now-marker on the light strip. 15.9:1 on Night Sea.
- **Mist** (#BAC7EB): secondary text. Teacher and status lines, onboarding leads, the week label, rooms inside list meta, explanatory text in centred states. 10.8:1 on Night Sea.
- **Fog** (#8FA2D1): labels and meta. The time column, field labels, fact labels, list meta, the source line, past pair titles, unselected weekday labels. 7.1:1 on Night Sea, 6.1:1 on Deep Water.

### Status
- **Coral Signal** (#FF9C8F): field error text only (9:1 on Night Sea). Errors are words under the field, never a red fill, border or banner.

### Named Rules
**The One Lamp Rule.** Lamp Amber is the only accent and it only marks what is lit, current or chosen: bars, dots, 2px rings, outlines, a single numeral. It never fills a button, card, tab or background. If a screen has nothing happening, it has no amber.

**The Porcelain Action Rule.** The primary action is a Porcelain fill with Night Sea text; the secondary action is a Swell fill with Porcelain text. No action is ever amber or a brighter blue.

## Typography

**Display Font:** Golos Text (with system-ui, -apple-system, Segoe UI, Roboto, sans-serif)
**Body Font:** Golos Text
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Consolas, monospace), for figures only

**Character:** Golos Text is a plain, contemporary grotesque drawn Cyrillic-first, so Russian reads cleanly at 12–13px and tightens well at headline sizes. JetBrains Mono turns times and rooms into instrument readings. The two never swap roles. Loaded from Google Fonts at Golos 400/500/600/700 and JetBrains Mono 500/600, so inline figures inside 400-weight text render at 500.

### Hierarchy
- **Display** (700, 28px, 1.15, -0.02em, balanced wrap): onboarding questions ("На каком вы курсе?").
- **Headline** (700, 26px, 1.2, -0.015em, balanced wrap): the lit pair's subject in the lamp card.
- **Title** (600, 22px, 1.15, -0.02em): the day heading ("Среда, 21 октября"). The profile sheet name uses the same size at 700.
- **Title-sm** (500, 16px, 1.3): pair subjects in the list.
- **Body-lg** (400, 17px): the text input value; keeps iOS from zooming on focus. Empty-state headings use 17px at 600.
- **Body** (400, 16px, 1.4): the base size; choice rows; the header name at 600.
- **Lead** (400, 15px, 1.5, held to 30–34ch): onboarding leads, empty and error explanations, profile rows.
- **Body-sm** (400, 14px): the day summary line, teacher line, status line, onboarding summary.
- **Label** (400, 13px): meta lines, field labels, help text, the week label, group headings in onboarding lists, break rows.
- **Caption** (400, 12px): fact labels (Аудитория, Время), the source line, weekday abbreviations, the "курс" word under course numerals.
- **Button** (600, 16px): button labels.
- **Figure-xl** (JetBrains Mono 600, 28px, 1): course numerals in onboarding.
- **Figure** (JetBrains Mono 600, 24px, -0.01em, tabular): room and time in the lamp card.
- **Figure-day** (JetBrains Mono 600, 18px): date numerals in the week strip.
- **Figure-sm** (JetBrains Mono, 13px, 1.45, -0.01em, tabular): the list's time column; break-row times at 12px; strip axis ticks at 11px.

### Named Rules
**The Tabular Figures Rule.** Clock times, rooms, dates, course numbers and group codes are JetBrains Mono with tabular figures and -0.01em tracking, wherever they appear, inline or standalone. A duration inside a sentence ("осталось **1 ч 10 мин**") stays in Golos at 600 with `tabular-nums`. Words never go mono.

**The Sentence-Case Rule.** Labels are sentence case at 12–13px in Fog. Nothing in the system is uppercase or tracked open; the only letter-spacing is negative, on headings and figures.

## Layout

One column, phone-first, built for one thumb inside Telegram's in-app webview.

- **Gutter:** 20px (`--gutter`) for the header, day heading, light strip, empty states and source line.
- **Surface inset:** surfaces with their own padding (lamp card, pair list) sit 16px from the edge. List rows carry 4px of side padding, so list text lands back on the 20px gutter.
- **Vertical rhythm:** sections open 18–26px apart, stepping in 2px (header 18, day heading 24, strip 18, card 20, list 18, source 26). There is no strict 8pt grid.
- **Time-column grid:** pair rows and break rows share one two-column grid, a 52px time column plus 1fr, with a 14px gap. Pair rows pad 13px vertically, break rows 10px; a 1px Deep Water hairline separates them. A second subgroup in the same pair drops its divider and its time.
- **Fixed week strip:** pinned to the bottom with Telegram's bottom inset added; the scroll content ends with a 132px + inset spacer so nothing hides beneath it.
- **Onboarding:** a full-height flex column with content at the top and the action pinned to the bottom by a flexible spacer, 32px + inset bottom padding. Course tiles use an auto-fill grid (min 72px, 10px gap).
- **Safe areas:** top inset is Telegram's safe area plus its content safe area; bottom inset is the larger of `env(safe-area-inset-bottom)` and Telegram's.
- **Wide viewports:** at 560px and up, the app column, the week strip and the sheet clamp to 520px and centre (desktop Telegram).

## Elevation & Depth

Flat and tonal. Depth comes from stepping the navy: Night Sea ground, Deep Water surface, Swell for pressed or selected. Hairline dividers are 1px of the next step up from the surface they cross (Deep Water on the ground, Swell inside a Deep Water surface). The week strip is solid Abyss with a Deep Water hairline on top; there is no blur and no translucency. The system holds exactly one lifted layer (the bottom sheet) and one emissive glow (the running pair).

### Shadow Vocabulary
- **Sheet lift** (`box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.35)`), over a scrim of `rgba(4, 9, 24, 0.6)`: the profile bottom sheet only.
- **Lamp beam** (`box-shadow: 0 0 10px 2px rgba(255, 170, 60, 0.7)`, opacity breathing on a 4s loop): the running pair's flash only.
- **Selection ring** (`box-shadow: inset 0 0 0 2px var(--lamp)`): selected choice row, selected course tile, focused input.
- **Resting ring** (`box-shadow: inset 0 0 0 1px var(--sea-4)`): the input at rest.

### Named Rules
**The Tonal Step Rule.** A surface is one navy step above what it sits on; pressed or selected is one step more. Cards and controls never get a drop shadow.

**The Lit-Only Glow Rule.** Only the running pair emits light. The beacon and progress segments may be amber, but nothing else casts a glow.

## Shapes

- **Control and surface radius** 14px (`--r`): buttons, choice rows, course tiles, the input, the onboarding summary, profile rows.
- **Larger containers:** the lamp card at 16px; the bottom sheet at 20px on its top corners only.
- **Smaller controls:** day tabs at 12px; icon buttons in the week strip at 8px.
- **Bars and marks:** strip flashes 3px, the strip track 6px, progress segments 3px, day ticks and the grabber 2px.
- **Circles:** avatar (42px, 84px in the sheet), status dot (9px), loading beacon (14px).
- **Borders:** controls have no borders. The only lines are 1px hairline dividers. Selection is drawn inside the shape (inset ring), so nothing shifts.
- **Focus:** a 2px Lamp Amber outline, 3px offset, 6px radius.
- **Icons:** inline SVG chevrons at 20px, 1.8 stroke, round caps and joins, `currentColor`. No icon font.

## Components

### Buttons
Solid, quiet bars that sit at the bottom of the thumb.
- **Shape:** gently rounded (14px), 54px tall, full width. In centred error states the button sizes to its label with 26px side padding.
- **Primary:** Porcelain fill, Night Sea text, 16px at 600.
- **Quiet:** Swell fill, Porcelain text ("Изменить данные" in the profile sheet).
- **Press / Focus / Disabled:** press scales to 0.985 over 160ms; focus shows the amber outline; disabled drops to 40% opacity with no press.
- **Icon buttons:** week arrows are 36×30px with Fog chevrons, Deep Water on press, 30% opacity when disabled. The onboarding back link (15px Mist with a chevron) shows only outside Telegram, where Telegram's own BackButton takes over.

### Choice Rows
The onboarding picker for direction and group.
- **Style:** Deep Water fill, 14px radius, min 54px tall, 14px × 16px padding, 8px apart, label left and chevron right; an optional 13px Fog hint.
- **State:** press goes to Swell and scales to 0.985; selected (`aria-pressed`) is Swell plus the inset amber ring.

### Course Tiles
- **Style:** auto-fill grid of 76px tiles, Deep Water fill, a 28px mono numeral over a 12px Fog "курс".
- **State:** press scales to 0.97; selected matches choice rows (Swell plus the amber ring).

### Inputs / Fields
- **Style:** Deep Water fill, 54px tall, 14px radius, 16px side padding, 17px text, a 1px Harbour Navy inset ring at rest. Label above in 13px Fog; help below in 13px Fog.
- **Focus:** the ring becomes 2px Lamp Amber over 160ms; the caret is amber; the placeholder is Fog.
- **Error:** a 13px Coral Signal line under the field. Nothing else changes colour.

### Navigation (Week Strip)
- **Style:** fixed to the bottom, solid Abyss with a Deep Water hairline. Row one: prev/next icon buttons around a 13px Mist week label ("Эта неделя · 19–24 октября"). Row two: day tabs Пн–Сб (Sunday only when it has pairs), each a 12px weekday, an 18px mono date numeral and up to six 5×4px ticks, one per pair.
- **States:** the selected day takes a Swell fill and its ticks turn amber; today's numeral is amber whether selected or not. Background changes over 200ms. A horizontal swipe on the content moves between days.

### Header
- The whole row is one button that opens the profile: a 42px avatar (Telegram photo, or initials on Harbour Navy), the name in 16px at 600 with ellipsis, a 13px Fog meta line (group code in mono · course), and a chevron.

### Lamp Card (signature)
The pair the lamp shines on: running now, or next today.
- **Corner / Background:** 16px radius, Deep Water, padding 18px 18px 16px. Rises 8px into place over 480ms.
- **Content:** the subject as Headline; kind · teacher in 14px Mist; a facts row (28px apart) of 12px Fog labels over 24px mono figures (Аудитория, Время); a status line under a Swell hairline with the amber dot and "Идёт 2 пара · осталось 1 ч 10 мин".
- Shown only on today. Other days show the list alone.

### Light Strip (signature)
The day's light characteristic: pairs are flashes, breaks are eclipses.
- **Track:** 12px Deep Water bar with a 6px radius inside a 38px block on the gutter.
- **Flashes:** each pair is placed and sized by its real start and end on a 9:00–16:05 axis (extended when the day ends later). Upcoming flashes are Unlit Navy, past flashes Harbour Navy, the running pair Lamp Amber with the lamp beam.
- **Now-marker:** a 2×24px Porcelain line at the current minute, today only. Axis ticks in 11px mono Fog at both ends.
- **Motion:** flashes enter from scaleX(0.4) with a fade over 520ms, staggered 70ms. The strip is `role="img"` with a spoken summary.

### Pair List
- **Rows:** the time column (start over end, 13px mono Fog) beside the subject (16px at 500) and a 13px Fog meta line (kind · ауд. room in Mist · teacher initials).
- **Breaks:** a break of 30 minutes or more is its own row on the same grid: the eclipse span in the time column at 12px mono, "Перерыв 45 мин" in 13px Fog.
- **Past:** past pairs recede. The title drops to Fog, and meta and times drop one step dimmer still.

### Bottom Sheet (profile)
- **Style:** Night Sea panel, 20px top corners, at most 88vh, a 38×4px Harbour Navy grabber, the sheet lift shadow over the scrim; slides up over 380ms, scrim fades over 240ms.
- **Content:** centred 84px avatar, the name in 22px at 700, a rows list (Deep Water, 14px radius, Swell hairlines, Fog label left, value right at 500), the quiet button, the source line.

### States
- **Loading:** a 14px amber beacon pulsing every 2.4s above a 15px Mist line.
- **Error / outside Telegram:** a centred 19px Porcelain heading, a 15px Mist explanation, and a primary button sized to its label.
- **Empty day:** a Deep Water hairline above, a 17px heading at 600, then a 15px Fog explanation.

## Do's and Don'ts

### Do:
- **Do** keep Lamp Amber (#FFD27A) to marks: bars, dots, 2px rings, outlines, a single numeral (The One Lamp Rule).
- **Do** build depth one navy step at a time: Night Sea ground (#0A1430), Deep Water surface (#12224B), Swell (#1A2C5C) for pressed or selected.
- **Do** set clock times, rooms, dates, course numbers and group codes in JetBrains Mono with tabular figures.
- **Do** make the primary action a 54px Porcelain bar (#EAF0FF fill, #0A1430 text, 14px radius) at the bottom of its screen.
- **Do** mark selection with an inset 2px amber ring on Swell so the layout never shifts.
- **Do** give every tappable element a press state (scale 0.985, tiles 0.97, 160ms, `cubic-bezier(0.16, 1, 0.3, 1)`) and the amber `:focus-visible` outline.
- **Do** add Telegram's safe-area insets to anything fixed to the top or bottom, and clamp the column to 520px at 560px and up.
- **Do** collapse all motion under `prefers-reduced-motion`, leaving the running pair's glow static.

### Don't:
- **Don't** fill a button, card, tab or background with amber, and don't add a second accent hue (no blue accent, no green "now").
- **Don't** put drop shadows on cards or controls; the bottom sheet is the only lifted layer.
- **Don't** use glass, backdrop blur or gradients; fixed bars are solid navy with a hairline.
- **Don't** set text in Harbour Navy (#253A75) or Unlit Navy (#36508F); they are marks, not ink.
- **Don't** rely on hover. This system has no hover states.
- **Don't** uppercase or open-track labels.
- **Don't** imitate the official MSU identity (crest, logotype, official colours) or present the app as an official university product.
