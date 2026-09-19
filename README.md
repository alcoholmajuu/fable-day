# MiniWarehouse

A miniature 3D warehouse simulator (Three.js + Vite + TypeScript). Stick-figure workers run a real
logistics loop: inbound trucks → unload → inspection → putaway → storage → orders → reserve → pick →
pack → stage → ship. Inventory, orders, jobs, and workers are one consistent state machine.

```
npm install
npm run dev      # http://localhost:5173
npm test         # typecheck + scenario tests + 2-hour headless soak with invariant checks
npm run build    # production bundle in dist/
```

URL parameters for testing: `?t=600` fast-forwards the sim, `&speed=4`, `&seed=42`, `&follow=W3`,
`&select=order:O5`, `&focus=cx,cz&zoom=6`, `&lite=1` (small shadow map for software GL).

Code layout: `src/sim` (pure simulation, no rendering), `src/render` (Three.js), `src/ui` (HUD), `test/`.
