/**
 * Living reference for the design system: open the app at /#design.
 * Shows every token and shared component in the current theme, so a change in
 * tokens.css or components.css can be checked in one screen, in light and dark.
 */
import React, { useState } from 'react';
import { setThemePref } from '../theme.js';
import { Button, Card, Count, IconButton, Input, Kbd, Menu, MenuItem, MenuSeparator, ModalBody, ModalFoot, ModalHead, Pill, Segmented, Select, Spinner, Textarea, Toggle } from '../ui/index.jsx';

const COLORS = [
  ['Surfaces', ['bg', 'sidebar', 'panel', 'panel-2', 'hover', 'active']],
  ['Lines and text', ['line', 'line-strong', 'text', 'text-2', 'muted']],
  ['Accent and status', ['accent', 'accent-hover', 'accent-soft', 'green', 'green-soft', 'red', 'red-soft', 'blue', 'blue-soft', 'warn', 'warn-soft', 'purple', 'purple-soft']],
  ['Code', ['code-bg', 'code-inline', 'diff-add', 'diff-del', 'term-bg']],
];
const TYPE = ['2xs', 'xs', 'sm', 'md', 'base', 'lg', 'title'];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];
const SPACE = ['0', '1', '1h', '2', '2h', '3', '3h', '4', '5', '6', '8'];
const SHADOWS = ['shadow-sm', 'shadow', 'shadow-pop'];

function Section({ title, children }) {
  return (
    <section className="ds-section">
      <h2 className="ds-h">{title}</h2>
      {children}
    </section>
  );
}

export default function Gallery() {
  const [toggle, setToggle] = useState(true);
  const [seg, setSeg] = useState('day');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  const pick = (t) => (setThemePref(t), setTheme(t));
  return (
    <div className="ds">
      <header className="ds-top">
        <span className="mark sm">&gt;_</span>
        <b>Design system</b>
        <span className="spacer" />
        <Segmented value={theme} onChange={pick} options={[['light', 'Light'], ['dark', 'Dark']]} />
        <Button size="sm" as="a" href="#">
          Back to the app
        </Button>
      </header>
      <main className="ds-main">
        <p className="muted">
          Tokens live in <code>web/src/design/tokens.css</code>, component styles in <code>components.css</code>, React components in <code>web/src/ui</code>.
        </p>

        <Section title="Color">
          {COLORS.map(([group, names]) => (
            <div key={group} className="ds-group">
              <div className="label">{group}</div>
              <div className="ds-swatches">
                {names.map((n) => (
                  <div key={n} className="ds-swatch">
                    <span style={{ background: `var(--${n})` }} />
                    <code>--{n}</code>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title="Type">
          {TYPE.map((t) => (
            <div key={t} className="ds-type" style={{ fontSize: `var(--fs-${t})` }}>
              <code>--fs-{t}</code> The quick brown fox jumps over the lazy dog
            </div>
          ))}
          <div className="ds-display">Display serif heading</div>
          <div className="mono">Monospace: const answer = 42;</div>
        </Section>

        <Section title="Radius, space, elevation">
          <div className="ds-row">
            {RADII.map((r) => (
              <div key={r} className="ds-radius" style={{ borderRadius: `var(--r-${r})` }}>
                {r}
              </div>
            ))}
          </div>
          <div className="ds-row ds-space">
            {SPACE.map((s) => (
              <div key={s}>
                <span style={{ width: `var(--sp-${s})`, height: `var(--sp-${s})` }} />
                <code>{s}</code>
              </div>
            ))}
          </div>
          <div className="ds-row">
            {SHADOWS.map((s) => (
              <div key={s} className="ds-shadow" style={{ boxShadow: `var(--${s})` }}>
                {s}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="ds-row">
            <Button variant="primary">Primary</Button>
            <Button>Default</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="dark">Dark</Button>
            <Button on>Selected</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="ds-row">
            <Button size="sm" variant="primary">
              Small primary
            </Button>
            <Button size="sm">Small</Button>
            <Button size="sm" variant="ghost">
              Small ghost
            </Button>
            <IconButton title="Copy">⧉</IconButton>
            <IconButton title="Selected" on>
              ±
            </IconButton>
            <IconButton title="Delete" danger>
              ✕
            </IconButton>
            <IconButton size="sm" title="Small">
              ⋯
            </IconButton>
            <IconButton title="With label">
              ◎ <span className="lbl">Browser</span>
            </IconButton>
          </div>
        </Section>

        <Section title="Inputs">
          <div className="ds-grid">
            <Input placeholder="Default input" />
            <Input size="sm" placeholder="Small input" />
            <Input size="lg" placeholder="Large input" />
            <Select defaultValue="b">
              <option value="a">Option A</option>
              <option value="b">Select</option>
            </Select>
            <Textarea mono rows={2} defaultValue={'KEY=value\nDEBUG=1'} />
            <Input disabled placeholder="Disabled" />
          </div>
          <div className="ds-row">
            <Toggle value={toggle} onChange={setToggle} label="Toggle" />
            <Toggle value={false} disabled label="Disabled toggle" />
            <Segmented value={seg} onChange={setSeg} options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} />
            <Spinner />
            <span>
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        </Section>

        <Section title="Pills and badges">
          <div className="ds-row">
            <Pill>Neutral</Pill>
            <Pill tone="accent">Running</Pill>
            <Pill tone="green">Done</Pill>
            <Pill tone="red">Failed</Pill>
            <Pill tone="warn">reconnecting…</Pill>
            <Pill tone="blue">Plan</Pill>
            <Pill tone="purple">Merged</Pill>
            <Pill mono>⎇ main</Pill>
            <span className="tag">user</span>
            <span>
              Tasks <Count>3</Count>
            </span>
            <span className="dot on" />
            <span className="dot busy" />
            <span className="dot off" />
            <span className="dot err" />
          </div>
        </Section>

        <Section title="Cards, menus, dialogs">
          <div className="ds-cards">
            <Card className="ds-card">
              <b>Card</b>
              <span className="muted text-sm">Bordered surface for list items.</span>
            </Card>
            <Card interactive className="ds-card">
              <b>Interactive card</b>
              <span className="muted text-sm">Highlights its border on hover.</span>
            </Card>
            <Card className="ds-card sunken">
              <b>Sunken card</b>
              <span className="muted text-sm">For forms inside a panel.</span>
            </Card>
            <div className="empty-box">Empty state box</div>
          </div>
          <div className="ds-row ds-floats">
            <div className="menu-wrap ds-menu-wrap">
              <Menu place="static">
                <MenuItem icon="✓" kbd="P">
                  Pin
                </MenuItem>
                <MenuItem kbd="R">Rename</MenuItem>
                <MenuItem hint="Hidden from the sidebar">Archive</MenuItem>
                <MenuSeparator />
                <MenuItem danger kbd="D">
                  Delete
                </MenuItem>
              </Menu>
            </div>
            <div className="modal-card ds-dialog">
              <ModalHead title="Dialog title" onClose={() => {}} />
              <ModalBody>
                <span>Dialogs use the panel surface, a 16px radius and the pop shadow.</span>
                <Input placeholder="Name" />
              </ModalBody>
              <ModalFoot>
                <Button>Cancel</Button>
                <Button variant="primary">Save</Button>
              </ModalFoot>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}
