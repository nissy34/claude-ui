# Design system

Everything visual in the UI comes from three places. Change a value here and every screen follows.

| What | Where |
| --- | --- |
| Tokens: colors (light and dark), type scale, spacing, radii, shadows, layers, motion | `tokens.css` |
| Look of shared controls: buttons, inputs, toggles, pills, cards, menus, dialogs, panes | `components.css` |
| React components for those controls | `../ui/index.jsx` |
| Screen layout (sidebar, chat, composer, settings, ...) | `../styles.css` |

Open the app at **`/#design`** to see every token and component in the current theme, with a light/dark switch.

## Rules

1. **No raw values in screens.** Colors, font sizes and radii in `styles.css` and JSX use tokens (`var(--accent)`, `var(--fs-md)`, `var(--r-lg)`). Pixel values are fine for layout (widths, offsets). No `style={{ color: … }}` or `fontSize` in JSX: use a class.
2. **Use the components.** `Button`, `IconButton`, `Menu`/`MenuItem`, `Modal`/`ModalHead`/`ModalBody`/`ModalFoot`, `Input`/`Select`/`Textarea`, `Pill`, `Count`, `Card`, `Toggle`, `Segmented`, `Spinner`, `Kbd` from `web/src/ui`. They pass through any props and merge `className`.
   - Dialogs close on Escape (top one only) and on a click outside. Menus: call `useDismiss(open, close, rootRef)` so they close on Escape and outside clicks. Ask with `confirmDialog()` / `promptDialog()` from `web/src/ui/dialogs.jsx`, never `window.confirm` / `window.prompt`.
3. **Forms:** put `fields` (and optionally `sm`) on a form or wrapper and every plain input, select and textarea inside gets the standard look, or use `className="field"` on a single control.
4. **Surfaces:** a bordered list item or panel is a `card` (`interactive` for clickable, `sunken` inside a panel). State labels are a `pill` with a tone (`accent`, `green`, `red`, `warn`, `blue`, `purple`).
5. **New token or component?** Add it to `tokens.css` / `components.css` (+ `ui/index.jsx`) and to the gallery (`Gallery.jsx`), not to a screen.

## Scales

- **Type:** `--fs-2xs` 10.5, `xs` 11.5, `sm` 12.5, `md` 13.5 (UI default), `base` 14, `lg` 15.5 (chat), `title` 17, `display` 30 (serif). Inputs on touch screens are 16px so phones don't zoom.
- **Space:** `--sp-0` 2, `1` 4, `1h` 6, `2` 8, `2h` 10, `3` 12, `3h` 14, `4` 16, `5` 20, `6` 24, `8` 32.
- **Radius:** `--r-xs` 4 (kbd, code), `sm` 6 (menu rows), `md` 8 (buttons, inputs), `lg` 10 (cards), `xl` 12 (menus, panels), `2xl` 16 (dialogs, bubbles), `3xl` 20 (composer), `full`.
- **Elevation:** `--shadow-sm` (knobs), `--shadow` (composer, floating pills), `--shadow-pop` (menus, dialogs).

The palette follows Claude Desktop: warm paper and charcoal surfaces with a terracotta accent. Only the accent and the syntax colors differ in hue between themes.
