# HTML Report Format

The architectural review is rendered as a single self-contained HTML file in the OS temp directory. Tailwind and Mermaid both come from CDNs. Mermaid handles graph-shaped diagrams reliably; hand-built divs and inline SVG handle the more editorial visuals. Mix the two.

## Scaffold

Use a simple static HTML page with:

- Tailwind via CDN
- Mermaid via CDN
- A compact header with repo name, date, and legend
- One candidate card per deepening opportunity
- A top-recommendation section at the end

## Candidate card

Each candidate card should include:

- **Title**
- **Recommendation badge** (`Strong`, `Worth exploring`, `Speculative`)
- **Files**
- **Before / After visualisation**
- **Problem**
- **Solution**
- **Wins**
- **ADR callout** when applicable

## Diagram patterns

Mix whichever presentation explains the structure best:

- Mermaid flowcharts or graphs for dependency or call flow
- Hand-built boxes and arrows when Mermaid fights the layout
- Cross-sections for layered shallowness
- Mass diagrams for interface-vs-implementation size
- Call-graph collapse for "many thin wrappers become one deep module"

## Style guidance

- Lean editorial, not dashboard-heavy
- Use colour sparingly
- Keep the prose tight and diagram-led
- Use the ``codebase-design`` vocabulary exactly

## Top recommendation section

One larger card naming the strongest candidate and why it should go first.
