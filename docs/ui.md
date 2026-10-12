# UI foundation

The frontend uses **shadcn/ui (Base UI, base-nova)** and **Tailwind CSS v4**.
`apps/desktop/ui/components.json` is the shadcn CLI configuration. Components
were generated with the official CLI and live in
`apps/desktop/ui/src/components/ui/`; application code imports them directly.
The former custom `components/ui.tsx` implementation is removed.

- `src/globals.css`: Tailwind, animation utilities, bundled IBM Plex Sans and
  the shadcn semantic token mapping.
- `src/theme.css`: Siftory light/dark palette. The existing theme provider resolves
  light/dark/system into `data-theme` on the document root; Tailwind's `dark`
  variant uses the same attribute, including portalled dropdowns.
- `src/styles.css`: application layout and composer composition only. Shared
  control styling belongs in the corresponding shadcn component, not here.
- `src/components/ui/`: Button, Input, Textarea, Select, Field, Label, Separator
  and Alert. Lucide supplies the icons. Local component sources include Siftory's
  sizing, focus and menu adjustments.

Add a component from the repository root:

```sh
bunx --bun shadcn add --cwd apps/desktop/ui <component>
```

Review registry updates before overwriting locally themed component files.
`bun run check` builds the UI; `bun run test` includes the component and theme
regression tests. No additional task, attachment or artifact features are enabled
by installing these components.
