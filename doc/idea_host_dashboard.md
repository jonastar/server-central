# Host dashboard — feature-contributed widgets on the per-host overview

Status: **implemented** (first slice). Extends
[idea_feature_interface.md](idea_feature_interface.md) §2 — this is the first piece of the
frontend registry that doc called for, built for widgets rather than for nav/routing.

The per-host overview was a hand-written page of four metric charts and a disk-usage list
(`ServerOverview.tsx`). Everything a feature knows about a host — the stacks running on it,
its pools, its failed units — lived only inside that feature's own tab. The overview is the
page you land on, so it should be the page that answers "what is this box doing", assembled
from whatever the features have to say and arranged by the operator.

## 1. Widgets are a frontend registry, not a wire format

The tempting design is for a server-side feature to *emit* dashboard items: the control plane
sends a list of `{ title, kind: "chart", series: [...] }` and the client renders them. Rejected,
for the same reason `idea_feature_convention.md` §0 rejected a plugin runtime — there are no
third-party feature authors to isolate, and the cost is real. It means inventing a rendering DSL
that has to grow a case for every visual a feature will ever want (a chart, a stack list with
per-row action menus, a usage bar, a status table), and every one of those cases is a React
component that already exists on the other side. The wire format would be a worse, lossier
spelling of the component tree.

So the registry is frontend-native, and only the *identity* crosses the wire — the same split
`FeatureDescriptor` already makes:

```ts
// apps/web/src/dashboard/types.ts
export interface DashboardWidget<TConfig = Record<string, unknown>> {
    id: string;                  // "system.cpu", "docker.stacks" — stable, stored in layouts
    featureId: string;           // matches the server FeatureDescriptor.id
    title: string;
    description: string;
    requires?: HostCapability;   // hidden on hosts whose agent reported it unavailable
    defaultSpan: WidgetSpan;
    minSpan?: WidgetSpan;
    inDefaultLayout?: number;    // sort key; absent = available in the palette only
    component: ComponentType<WidgetProps<TConfig>>;
    configForm?: ComponentType<WidgetConfigProps<TConfig>>;
    defaultConfig?: TConfig;
    /** Instance subtitle, so two cards of one widget are distinguishable. */
    label?(config: TConfig): string | null;
}
```

`registry.ts` composes the per-feature widget arrays exactly like `composeApiHandlers` composes
API slices: a dumb concatenation that throws on a duplicate id. A feature owns its widgets in
`dashboard/widgets/<feature>.tsx`, next to the components they reuse.

**Config forms are components, not schemas.** A widget that pins one specific compose stack
needs to offer *this host's* stacks in a dropdown, which no static field descriptor can express
without growing an options-fetching protocol. Handing the widget a `configForm` component with
`{ serverId, config, onChange }` costs nothing and is strictly more capable — the same argument
as §1 one level down.

## 2. Live data: three tiers, and the hard one is not the charts

The instinct is that live CPU charts are the hard part. They aren't — that data already streams.
`node-server.ts` pushes a `metrics` event per host per sample, `ConnectionManager` keeps the last
720 snapshots per host in `ConnectionState.metrics[serverId]`, and a widget that wants a live
chart just calls `useConnection()`. Zero new protocol, zero new requests, and the chart is live
because the store behind it is.

The tiers, in the order a widget author should reach for them:

1. **Already-pushed state** — anything in `ConnectionState` (metrics, server status, task runs).
   Free and live. CPU, memory, network, disk IO, disk usage, host info all sit here.
2. **Polled operations** — `listHostComposeStacks`, `getZfsState`, `listServices`. This is the
   tier that needed work: every existing view hand-rolls `useEffect` + `setInterval(10s)`, which
   is fine for one view at a time and is not fine for eight cards on one page. `useHostPoll`
   (`dashboard/useHostPoll.ts`) is one shared cache keyed by `(operation, serverId, args)` that
   - **dedupes** — two widgets asking for the same thing share one in-flight request and one
     timer, so pinning three stack cards costs one `listHostComposeStacks` poll, not three;
   - **pauses** when `document.hidden`, when the host is not `online`, and when the last
     subscriber unmounts. A background tab of a fleet dashboard should cost nothing;
   - **backs off** on error (10s → 20s → 40s, capped at 60s) instead of hammering a host that
     is answering with a stack trace.
3. **A dedicated push channel** — deliberately not built. Nothing yet needs sub-poll latency
   that isn't already in tier 1. If something does (live container state, say), the shape to
   reach for is another `ApiEvent` kind fed by the existing broadcast, not a generic
   "subscribe to widget" mechanism.

### The adoption side effect

`listHostComposeStacks` **adopts** running stacks into the registry as a side effect of reading
(`HostComposeStacks`'s doc comment says so outright). That is defensible for a page you
navigated to on purpose and wrong for a card that polls every 10 seconds on the landing page of
every host. The stacks widget therefore reads `listComposeStacks` + `listDockerStacks` and merges
them itself, which is the same merge `DockerStacks.tsx` does, minus the write.

## 3. Layout

One arrangement per host, stored on the control plane (`.sc-data/dashboards.json`), not per user
and not in `localStorage`. The layout describes the box — "on this host, what matters is the
stacks and the pool" — not the person looking at it, and it should survive a different browser.

```ts
export interface DashboardWidgetInstance {
    id: string;         // per-instance, so two cards of one widget stay distinct
    widget: string;     // DashboardWidget.id
    span: 1 | 2 | 3;
    config?: Record<string, unknown>;   // opaque to the control plane
}
```

`config` is deliberately opaque server-side. The control plane validates *structure* — known
span, unique instance ids, a cap on how many cards a dashboard may hold, a cap on serialized
config size — and nothing about meaning. A widget's config schema is the widget's business, and
teaching the server about it would put half of each feature's frontend in `shared/`.

**A host with no stored layout gets no row in the file.** `getHostDashboard` answers `null`, and
the client builds the default from the registry: every widget with `inDefaultLayout`, sorted,
filtered by host capability. That means today's overview is reproduced exactly for every existing
host without a migration, and a newly-added widget appears on every uncustomized host for free.

The cost of that choice, stated plainly: a host someone *has* customized is frozen — a widget
added by a later release will not appear on it, because the stored list is the whole truth. The
alternative (storing removals rather than placements, and merging new widgets in) makes "I
arranged this page" mean something conditional, and produces cards appearing unbidden on a page
someone deliberately laid out. Explicit-list-wins is the less surprising failure, and the "Add
widget" palette is the answer to it. Revisit if a release ever adds a widget everyone would want
retrofitted.

### Ordered flow, not a free 2D grid

Three columns; each card picks a span of 1–3; cards flow in order. Reorder by dragging a card,
resize with a span control in edit mode. Grafana-style free x/y/w/h placement was the other
candidate and was turned down: it needs collision and reflow machinery (or `react-grid-layout`,
a dependency in a frontend that hand-rolls even its own charts, in `charts.tsx`), it produces
layouts that break at narrow widths, and the flow model degrades to one column on a phone by
doing nothing. Span is stored as a number rather than a CSS class so a later 4-column layout is
a render change, not a migration.

## 4. What this does not do yet

- **Fleet dashboard.** `Dashboard.tsx` is still the hand-written card grid. Its widgets would be
  fleet-scoped (aggregate across hosts) rather than host-scoped, which is a different `WidgetProps`
  and a different default-layout question — a second registry, sharing `useHostPoll` and the
  layout store shape. Worth doing, deliberately not bundled in.
- **Per-widget refresh intervals.** One 10s cadence for tier 2, matching what the views did.
- **RBAC.** Editing a layout is available to any authenticated user, like nearly everything else
  — see the RBAC gap in [next.md](../next.md). When roles are enforced, layout editing is an
  operator-and-up action and viewing is not.
- **Widget-level error isolation beyond a boundary.** Each card renders inside an error boundary
  so one throwing widget can't blank the page, but a widget that renders wrong (rather than
  throwing) is on its own.
